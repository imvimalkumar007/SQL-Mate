pub mod anthropic;
pub mod openai;

use serde::{Deserialize, Serialize};

pub use anthropic::AnthropicProvider;
pub use openai::OpenAIProvider;

/// Closed enum dispatch over the LLM providers we support. See ADR 0010.
pub enum Provider {
    Anthropic(AnthropicProvider),
    OpenAI(OpenAIProvider),
    OpenAICompatible(OpenAIProvider),
}

impl Provider {
    pub async fn generate_sql(
        &self,
        req: SqlGenerationRequest,
    ) -> Result<SqlGenerationResponse, LlmError> {
        match self {
            Provider::Anthropic(p) => p.generate_sql(req).await,
            Provider::OpenAI(p) => p.generate_sql(req).await,
            Provider::OpenAICompatible(p) => p.generate_sql(req).await,
        }
    }

    pub fn capabilities(&self) -> ProviderCapabilities {
        match self {
            Provider::Anthropic(_) => ProviderCapabilities {
                supports_prompt_caching: true,
                supports_structured_output: true,
            },
            Provider::OpenAI(_) => ProviderCapabilities {
                supports_prompt_caching: false,
                supports_structured_output: true,
            },
            Provider::OpenAICompatible(_) => ProviderCapabilities {
                supports_prompt_caching: false,
                supports_structured_output: false,
            },
        }
    }
}

#[derive(Debug, Clone)]
pub struct SqlGenerationRequest {
    pub system_prompt: String,
    pub user_message: String,
    pub model: String,
    pub max_tokens: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SqlGenerationResponse {
    pub sql: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub explanation: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confidence: Option<f32>,
}

#[derive(Debug, Clone, Copy, Serialize)]
pub struct ProviderCapabilities {
    pub supports_prompt_caching: bool,
    pub supports_structured_output: bool,
}

#[derive(Debug)]
pub enum LlmError {
    Auth(String),
    RateLimit,
    ModelNotFound(String),
    ContextTooLarge,
    Network(String),
    Provider(String),
}

impl std::fmt::Display for LlmError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            LlmError::Auth(msg) => write!(f, "Authentication failed. {msg}"),
            LlmError::RateLimit => {
                write!(f, "Provider rate-limited the request; try again shortly.")
            }
            LlmError::ModelNotFound(model) => {
                write!(f, "Model {model} not recognized by the provider.")
            }
            LlmError::ContextTooLarge => write!(
                f,
                "The schema + question exceeds the model's context window. Narrow the schema or pick a larger model."
            ),
            LlmError::Network(msg) => write!(f, "Network error: {msg}"),
            LlmError::Provider(msg) => write!(f, "Provider error: {msg}"),
        }
    }
}

impl std::error::Error for LlmError {}
