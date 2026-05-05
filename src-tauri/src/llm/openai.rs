// OpenAI / OpenAI-compatible Chat Completions provider. See ADR 0010.
//
// Used by both Provider::OpenAI (base_url = https://api.openai.com) and
// Provider::OpenAICompatible (any base URL exposing /v1/chat/completions —
// Groq, Together, Fireworks, Azure OpenAI, OpenRouter, Ollama, vLLM, etc.).

use serde::{Deserialize, Serialize};

use super::{LlmError, SqlGenerationRequest, SqlGenerationResponse};

pub struct OpenAIProvider {
    api_key: String,
    base_url: String,
    model: String,
    extra_headers: Vec<(String, String)>,
}

impl OpenAIProvider {
    pub fn new(api_key: String, base_url: String, model: String) -> Self {
        Self {
            api_key,
            base_url,
            model,
            extra_headers: Vec::new(),
        }
    }

    /// For Azure OpenAI (api-key header) or OpenRouter (X-Title, HTTP-Referer)
    /// or anything else that needs custom headers without changing the
    /// request body shape.
    #[allow(dead_code)]
    pub fn with_headers(mut self, headers: Vec<(String, String)>) -> Self {
        self.extra_headers = headers;
        self
    }

    pub async fn generate_sql(
        &self,
        req: SqlGenerationRequest,
    ) -> Result<SqlGenerationResponse, LlmError> {
        let url = format!(
            "{}/v1/chat/completions",
            self.base_url.trim_end_matches('/')
        );
        let model = if req.model.is_empty() {
            self.model.clone()
        } else {
            req.model
        };

        let body = ChatRequest {
            model,
            max_tokens: req.max_tokens,
            messages: vec![
                ChatMessage {
                    role: "system",
                    content: req.system_prompt,
                },
                ChatMessage {
                    role: "user",
                    content: req.user_message,
                },
            ],
        };

        let client = reqwest::Client::new();
        let mut builder = client
            .post(&url)
            .header("authorization", format!("Bearer {}", self.api_key))
            .header("content-type", "application/json");
        for (k, v) in &self.extra_headers {
            builder = builder.header(k, v);
        }
        let response = builder
            .json(&body)
            .send()
            .await
            .map_err(|e| LlmError::Network(e.to_string()))?;

        let status = response.status();
        if !status.is_success() {
            let body_text = response.text().await.unwrap_or_default();
            return Err(match status.as_u16() {
                401 | 403 => LlmError::Auth(body_text),
                404 => LlmError::ModelNotFound(self.model.clone()),
                429 => LlmError::RateLimit,
                400 if body_text.to_lowercase().contains("context_length") => {
                    LlmError::ContextTooLarge
                }
                _ => LlmError::Provider(format!("HTTP {}: {}", status.as_u16(), body_text)),
            });
        }

        let parsed: ChatResponse = response
            .json()
            .await
            .map_err(|e| LlmError::Provider(format!("could not parse response: {e}")))?;

        let sql = parsed
            .choices
            .into_iter()
            .next()
            .and_then(|c| c.message.content)
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .ok_or_else(|| LlmError::Provider("empty response from provider".into()))?;

        Ok(SqlGenerationResponse {
            sql,
            explanation: None,
            confidence: None,
        })
    }
}

#[derive(Serialize)]
struct ChatRequest {
    model: String,
    max_tokens: u32,
    messages: Vec<ChatMessage>,
}

#[derive(Serialize)]
struct ChatMessage {
    role: &'static str,
    content: String,
}

#[derive(Deserialize)]
struct ChatResponse {
    choices: Vec<ChatChoice>,
}

#[derive(Deserialize)]
struct ChatChoice {
    message: ChatChoiceMessage,
}

#[derive(Deserialize)]
struct ChatChoiceMessage {
    content: Option<String>,
}
