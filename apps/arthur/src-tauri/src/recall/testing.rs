//! Test doubles for retrieval: a deterministic embedding provider that counts what it is asked to embed.
//!
//! `ConceptEmbedder` is NOT a language model. It maps words to hand-declared concepts and hashes concepts into a vector, so two
//! texts that share concepts (but no words) are close. That lets CI exercise the semantic path deterministically; it says nothing
//! about the quality of a real embedding model, which only the live benchmark can measure.

use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use super::query::tokens;
use crate::async_util::BoxFuture;
use crate::providers::embed::{normalize, EmbedFailure, EmbedPurpose, EmbeddingProvider, ModelKey};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Behaviour {
    Work,
    Fail(EmbedFailure),
    /// Answers only after this long (to exercise the timeout).
    Delay(Duration),
}

pub struct ConceptEmbedder {
    key: ModelKey,
    dims: usize,
    /// Token prefix -> concept name. The longest matching prefix wins; a token with no concept stands for itself.
    concepts: Vec<(String, String)>,
    pub behaviour: Mutex<Behaviour>,
    pub requests: AtomicU32,
    pub texts: AtomicU32,
    pub purposes: Mutex<Vec<EmbedPurpose>>,
}

impl ConceptEmbedder {
    pub fn new(dims: usize, concepts: &[(&str, &str)]) -> Self {
        let mut concepts: Vec<(String, String)> = concepts.iter().map(|(p, c)| (p.to_string(), c.to_string())).collect();
        concepts.sort_by(|a, b| b.0.len().cmp(&a.0.len()).then_with(|| a.0.cmp(&b.0)));
        Self { key: ModelKey::new("test", "concept", dims, "v1"), dims, concepts, behaviour: Mutex::new(Behaviour::Work), requests: AtomicU32::new(0), texts: AtomicU32::new(0), purposes: Mutex::new(Vec::new()) }
    }

    #[allow(dead_code)]
    pub fn plain(dims: usize) -> Self {
        Self::new(dims, &[])
    }

    pub fn set(&self, behaviour: Behaviour) {
        *self.behaviour.lock().unwrap() = behaviour;
    }

    pub fn request_count(&self) -> u32 {
        self.requests.load(Ordering::SeqCst)
    }

    pub fn text_count(&self) -> u32 {
        self.texts.load(Ordering::SeqCst)
    }

    pub fn vector_of(&self, text: &str) -> Vec<f32> {
        let mut vector = vec![0.0f32; self.dims];
        for token in tokens(text) {
            let concept = self.concepts.iter().find(|(prefix, _)| token.starts_with(prefix.as_str())).map(|(_, c)| c.as_str()).unwrap_or(token.as_str());
            let hash = concept.bytes().fold(0xcbf29ce484222325u64, |h, b| (h ^ u64::from(b)).wrapping_mul(0x100000001b3));
            vector[(hash % self.dims as u64) as usize] += 1.0;
            vector[((hash >> 20) % self.dims as u64) as usize] += 0.5;
        }
        if !normalize(&mut vector) {
            vector[0] = 1.0;
        }
        vector
    }
}

impl EmbeddingProvider for ConceptEmbedder {
    fn model_key(&self) -> &ModelKey {
        &self.key
    }

    fn dims(&self) -> usize {
        self.dims
    }

    fn embed<'a>(&'a self, texts: &'a [String], purpose: EmbedPurpose) -> BoxFuture<'a, Result<Vec<Vec<f32>>, EmbedFailure>> {
        self.requests.fetch_add(1, Ordering::SeqCst);
        self.texts.fetch_add(texts.len() as u32, Ordering::SeqCst);
        self.purposes.lock().unwrap().push(purpose);
        let behaviour = self.behaviour.lock().unwrap().clone();
        Box::pin(async move {
            match behaviour {
                Behaviour::Work => Ok(texts.iter().map(|t| self.vector_of(t)).collect()),
                Behaviour::Fail(failure) => Err(failure),
                Behaviour::Delay(delay) => {
                    tokio::time::sleep(delay).await;
                    Ok(texts.iter().map(|t| self.vector_of(t)).collect())
                }
            }
        })
    }
}

use crate::storage::capture_store::{CaptureStore, CreateCaptureInput};
use crate::storage::knowledge_store::NewKnowledgeObject;
use crate::storage::lineage_store::{Changes, RevisionContent};

/// A real store built only through the real write paths (capture -> distillation -> edit/branch/merge -> move -> archive).
pub struct Lab {
    pub store: CaptureStore,
}

impl Lab {
    pub fn new() -> Self {
        Self { store: CaptureStore::open_in_memory().unwrap() }
    }

    pub fn project(&self, name: &str) -> String {
        self.store.create_project(name).unwrap().id
    }

    /// One capture holding the object's own words, distilled into exactly one object that spans the whole capture.
    pub fn object(&self, project: &str, kind: &str, title: &str, body: &str) -> String {
        let content = format!("{title}. {body}");
        let capture = self.store.create(CreateCaptureInput { source: "text".into(), content: content.clone(), project_id: Some(project.to_string()) }).unwrap();
        let length = content.chars().count() as i64;
        let objects = self.store.record_distillation(&capture.id, vec![NewKnowledgeObject { kind: kind.into(), title: title.into(), body: body.into(), source_start: 0, source_end: length }]).unwrap();
        objects[0].id.clone()
    }

    pub fn edit(&self, object_id: &str, title: Option<&str>, body: Option<&str>) -> String {
        self.store.update_object(object_id, Changes { kind: None, title: title.map(String::from), body: body.map(String::from) }).unwrap().id
    }

    pub fn current_revision(&self, object_id: &str) -> String {
        self.store.object_lineage(object_id).unwrap().current_revision_id
    }

    pub fn root_revision(&self, object_id: &str) -> String {
        self.store.list_revisions(object_id).unwrap()[0].id.clone()
    }

    pub fn branch(&self, object_id: &str, from: &str, title: &str, body: &str, make_current: bool) -> String {
        self.store.create_revision_from(object_id, from, Changes { kind: None, title: Some(title.into()), body: Some(body.into()) }, make_current).unwrap().id
    }

    pub fn merge(&self, object_id: &str, parents: &[String], title: &str, body: &str, make_current: bool) -> String {
        self.store.merge_revisions(object_id, parents, RevisionContent { kind: "idea".into(), title: title.into(), body: body.into() }, make_current).unwrap().id
    }
}

pub fn run<F: std::future::Future>(future: F) -> F::Output {
    tauri::async_runtime::block_on(future)
}
