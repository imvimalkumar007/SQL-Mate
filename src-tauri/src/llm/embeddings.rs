// Embedding provider — calls the OpenAI-shape /v1/embeddings endpoint.
// Anthropic is not supported (no embeddings API). See ADR 0011.

use serde::{Deserialize, Serialize};

use super::LlmError;

/// Request a batch of embeddings. The response preserves order: the i-th
/// embedding corresponds to the i-th input string.
pub async fn embed_openai(
    api_key: &str,
    base_url: &str,
    model: &str,
    inputs: Vec<String>,
) -> Result<Vec<Vec<f32>>, LlmError> {
    if inputs.is_empty() {
        return Ok(Vec::new());
    }
    let url = format!("{}/v1/embeddings", base_url.trim_end_matches('/'));

    let body = EmbeddingRequest { model, input: inputs };
    let client = reqwest::Client::new();
    let response = client
        .post(&url)
        .header("authorization", format!("Bearer {}", api_key))
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
            404 => LlmError::ModelNotFound(model.to_string()),
            429 => LlmError::RateLimit,
            _ => LlmError::Provider(format!("HTTP {}: {}", status.as_u16(), body_text)),
        });
    }

    let parsed: EmbeddingResponse = response
        .json()
        .await
        .map_err(|e| LlmError::Provider(format!("could not parse embeddings response: {e}")))?;

    // The provider may return data in any order, but OpenAI's contract
    // (and every compatible provider we've seen) returns it indexed by the
    // input position. We sort by `index` defensively.
    let mut data = parsed.data;
    data.sort_by_key(|d| d.index);
    Ok(data.into_iter().map(|d| d.embedding).collect())
}

#[derive(Serialize)]
struct EmbeddingRequest<'a> {
    model: &'a str,
    input: Vec<String>,
}

#[derive(Deserialize)]
struct EmbeddingResponse {
    data: Vec<EmbeddingItem>,
}

#[derive(Deserialize)]
struct EmbeddingItem {
    #[serde(default)]
    index: usize,
    embedding: Vec<f32>,
}
