//! Test-only fake classifier: replays a scripted reply and records what it was shown.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;

use super::classifier::*;
use super::types::*;

pub struct FakeClassifier {
    reply: Mutex<Result<ClassifierOutput, ClassifierFailure>>,
    calls: AtomicUsize,
    shown: Mutex<Vec<Vec<String>>>,
}

impl FakeClassifier {
    pub fn replying(reply: Result<ClassifierOutput, ClassifierFailure>) -> Self {
        Self {
            reply: Mutex::new(reply),
            calls: AtomicUsize::new(0),
            shown: Mutex::new(Vec::new()),
        }
    }

    pub fn calls(&self) -> usize {
        self.calls.load(Ordering::SeqCst)
    }

    /// The candidate ids shown on each call.
    pub fn shown(&self) -> Vec<Vec<String>> {
        self.shown.lock().unwrap().clone()
    }
}

impl IdentityClassifier for FakeClassifier {
    fn classify(
        &self,
        request: &ClassifyRequest<'_>,
    ) -> Result<ClassifierOutput, ClassifierFailure> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.shown.lock().unwrap().push(
            request
                .candidates
                .iter()
                .map(|c| c.object_id.clone())
                .collect(),
        );
        self.reply.lock().unwrap().clone()
    }
}

pub const MODEL: &str = "fake-1";

pub fn signal(id: &str, same: f64, relation: Relation) -> CandidateSignal {
    CandidateSignal {
        candidate_id: id.into(),
        same_proposition: same,
        reframing: 0.0,
        relation: Some(relation),
        referent_resolved: Some(true),
        explicit_supersession: Some(false),
    }
}

/// Three identical runs, as unanimity requires.
pub fn unanimous(signals: Vec<CandidateSignal>) -> ClassifierOutput {
    ClassifierOutput {
        model_id: MODEL.into(),
        runs: vec![signals.clone(), signals.clone(), signals],
    }
}
