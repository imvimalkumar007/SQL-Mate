// Anthropic Messages API provider. See ADR 0010 for the abstraction shape.

use serde::{Deserialize, Serialize};

use super::{LlmError, SqlGenerationRequest, SqlGenerationResponse};

const ANTHROPIC_API_VERSION: &str = "2023-06-01";

pub struct AnthropicProvider {
    api_key: String,
    base_url: String,
    model: String,
}

impl AnthropicProvider {
    pub fn new(api_key: String, base_url: String, model: String) -> Self {
        Self {
            api_key,
            base_url,
            model,
        }
    }

    pub async fn generate_sql(
        &self,
        req: SqlGenerationRequest,
    ) -> Result<SqlGenerationResponse, LlmError> {
        let url = format!("{}/v1/messages", self.base_url.trim_end_matches('/'));
        let model = if req.model.is_empty() {
            self.model.clone()
        } else {
            req.model
        };

        let body = AnthropicRequest {
            model,
            max_tokens: req.max_tokens,
            system: req.system_prompt,
            messages: vec![Message {
                role: "user",
                content: req.user_message,
            }],
        };

        let client = reqwest::Client::new();
        let response = client
            .post(&url)
            .header("x-api-key", &self.api_key)
            .header("anthropic-version", ANTHROPIC_API_VERSION)
            .header("content-type", "application/json")
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
                400 if body_text.to_lowercase().contains("context") => LlmError::ContextTooLarge,
                _ => LlmError::Provider(format!("HTTP {}: {}", status.as_u16(), body_text)),
            });
        }

        let parsed: AnthropicResponse = response
            .json()
            .await
            .map_err(|e| LlmError::Provider(format!("could not parse response: {e}")))?;

        let sql = parsed
            .content
            .into_iter()
            .find_map(|b| if b.block_type == "text" { b.text } else { None })
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .ok_or_else(|| LlmError::Provider("empty response from Anthropic".into()))?;

        Ok(SqlGenerationResponse {
            sql,
            explanation: None,
            confidence: None,
        })
    }
}

#[derive(Serialize)]
struct AnthropicRequest {
    model: String,
    max_tokens: u32,
    system: String,
    messages: Vec<Message>,
}

#[derive(Serialize)]
struct Message {
    role: &'static str,
    content: String,
}

#[derive(Deserialize)]
struct AnthropicResponse {
    content: Vec<ContentBlock>,
}

#[derive(Deserialize)]
struct ContentBlock {
    #[serde(rename = "type")]
    block_type: String,
    text: Option<String>,
}
