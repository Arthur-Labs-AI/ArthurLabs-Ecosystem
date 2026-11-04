//! The cloud answer model behind Recall's `AnswerModel` abstraction: one strict-JSON chat completion, no tools.
//!
//! Reuses the shared `chat::complete_json` (key handling, redirect safety, refusal and truncation classification), so a different vendor
//! is another implementation of the trait and nothing in Recall changes.

use std::fmt;
use std::sync::Arc;
use std::time::Duration;

use super::chat::{self, ChatFailure, ChatRequest, Sampling, DEFAULT_ENDPOINT, DEFAULT_MODEL};
use super::credentials::CredentialSource;
use super::http;
use crate::async_util::BoxFuture;
use crate::recall::synthesis::{AnswerModel, SynthesisFailure, SynthesisRequest};

const REQUEST_TIMEOUT: Duration = Duration::from_secs(60);

pub struct OpenAiAnswerModel {
    client: reqwest::Client,
    endpoint: String,
    model: String,
    credentials: Arc<dyn CredentialSource>,
}

impl fmt::Debug for OpenAiAnswerModel {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("OpenAiAnswerModel")
            .field("endpoint", &self.endpoint)
            .field("model", &self.model)
            .finish_non_exhaustive()
    }
}

impl OpenAiAnswerModel {
    /// `gpt-4.1-mini`: the non-reasoning model Arthur still uses for Ask Arthur answers and Automatic Connections Stage A (deterministic at
    /// temperature 0). Not part of the GPT-6 Luna migration (distillation, revision synthesis and Stage B).
    pub fn new(credentials: Arc<dyn CredentialSource>) -> Result<Self, reqwest::Error> {
        Self::with_endpoint(credentials, DEFAULT_ENDPOINT, DEFAULT_MODEL)
    }

    pub fn with_endpoint(
        credentials: Arc<dyn CredentialSource>,
        endpoint: &str,
        model: &str,
    ) -> Result<Self, reqwest::Error> {
        Ok(Self {
            client: http::client(REQUEST_TIMEOUT)?,
            endpoint: endpoint.to_string(),
            model: model.to_string(),
            credentials,
        })
    }

    async fn request(&self, request: &SynthesisRequest) -> Result<String, SynthesisFailure> {
        chat::complete_json(
            &self.client,
            self.credentials.as_ref(),
            ChatRequest {
                endpoint: &self.endpoint,
                model: &self.model,
                system: &request.system,
                user: &request.user,
                schema_name: "recall_answer",
                schema: request.schema.clone(),
                sampling: Sampling::Deterministic,
                max_output_tokens: None,
            },
        )
        .await
        .map_err(|failure| match failure {
            ChatFailure::NotConfigured => SynthesisFailure::NotConfigured,
            ChatFailure::Network => SynthesisFailure::Network,
            ChatFailure::Auth(status) => SynthesisFailure::Auth(status),
            ChatFailure::Provider(status) => SynthesisFailure::Provider(status),
            ChatFailure::Refused => SynthesisFailure::Refused,
            ChatFailure::Unreadable(reason) => SynthesisFailure::Unreadable(reason),
        })
    }
}

impl AnswerModel for OpenAiAnswerModel {
    fn model_name(&self) -> String {
        self.model.clone()
    }

    fn complete<'a>(
        &'a self,
        request: &'a SynthesisRequest,
    ) -> BoxFuture<'a, Result<String, SynthesisFailure>> {
        Box::pin(self.request(request))
    }
}
