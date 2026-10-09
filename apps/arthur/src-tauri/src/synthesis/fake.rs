//! Test-only doubles for the synthesis and verification boundaries.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use super::*;

pub const SYNTH_MODEL: &str = "gpt-6-luna";

type SynthFn = dyn Fn(&SynthesisRequest) -> Result<SynthesisDraft, SynthesisFailure> + Send + Sync;

pub struct ScriptedSynthesizer {
    answer: Mutex<Box<SynthFn>>,
    pub calls: AtomicUsize,
    pub seen: Mutex<Vec<SynthesisRequest>>,
    hook: Mutex<Option<Arc<dyn Fn() + Send + Sync>>>,
    family: &'static str,
}

impl ScriptedSynthesizer {
    pub fn new(answer: impl Fn(&SynthesisRequest) -> Result<SynthesisDraft, SynthesisFailure> + Send + Sync + 'static) -> Arc<Self> {
        Arc::new(Self { answer: Mutex::new(Box::new(answer)), calls: AtomicUsize::new(0), seen: Mutex::new(vec![]), hook: Mutex::new(None), family: "fake-synthesis-family" })
    }
    /// A synthesizer that claims a model family, to build same-family pairings.
    pub fn in_family(family: &'static str, answer: impl Fn(&SynthesisRequest) -> Result<SynthesisDraft, SynthesisFailure> + Send + Sync + 'static) -> Arc<Self> {
        Arc::new(Self { answer: Mutex::new(Box::new(answer)), calls: AtomicUsize::new(0), seen: Mutex::new(vec![]), hook: Mutex::new(None), family })
    }
    pub fn calls(&self) -> usize {
        self.calls.load(Ordering::SeqCst)
    }
    /// Runs while "the model is working": the world can change underneath.
    pub fn during(&self, hook: impl Fn() + Send + Sync + 'static) {
        *self.hook.lock().unwrap() = Some(Arc::new(hook));
    }
}

impl RevisionSynthesizer for ScriptedSynthesizer {
    fn identity(&self) -> ModelIdentity {
        ModelIdentity { provider: "fake", family: self.family, model: SYNTH_MODEL.into() }
    }

    fn synthesize<'a>(&'a self, request: &'a SynthesisRequest) -> BoxFuture<'a, Result<SynthesisDraft, SynthesisFailure>> {
        Box::pin(async move {
            self.calls.fetch_add(1, Ordering::SeqCst);
            self.seen.lock().unwrap().push(request.clone());
            let hook = self.hook.lock().unwrap().clone();
            if let Some(hook) = hook {
                hook();
            }
            (self.answer.lock().unwrap())(request)
        })
    }
}

pub struct ScriptedVerifier {
    verdict: Mutex<Box<dyn Fn(&VerifyRequest) -> Verdict + Send + Sync>>,
    pub calls: AtomicUsize,
    pub seen: Mutex<Vec<VerifyRequest>>,
    hook: Mutex<Option<Arc<dyn Fn() + Send + Sync>>>,
    family: &'static str,
}

impl ScriptedVerifier {
    pub fn new(verdict: impl Fn(&VerifyRequest) -> Verdict + Send + Sync + 'static) -> Arc<Self> {
        Arc::new(Self { verdict: Mutex::new(Box::new(verdict)), calls: AtomicUsize::new(0), seen: Mutex::new(vec![]), hook: Mutex::new(None), family: "fake-verifier-family" })
    }
    pub fn passing() -> Arc<Self> {
        Self::new(|_| Verdict::Pass)
    }
    /// A verifier of the SYNTHESIZER's family, to prove such a pairing is refused.
    pub fn same_family_as_synthesizer() -> Arc<Self> {
        Arc::new(Self { verdict: Mutex::new(Box::new(|_| Verdict::Pass)), calls: AtomicUsize::new(0), seen: Mutex::new(vec![]), hook: Mutex::new(None), family: "fake-synthesis-family" })
    }
    pub fn calls(&self) -> usize {
        self.calls.load(Ordering::SeqCst)
    }
    pub fn during(&self, hook: impl Fn() + Send + Sync + 'static) {
        *self.hook.lock().unwrap() = Some(Arc::new(hook));
    }
}

impl RevisionVerifier for ScriptedVerifier {
    fn identity(&self) -> ModelIdentity {
        ModelIdentity { provider: "fake", family: self.family, model: "verifier-1".into() }
    }

    fn verify<'a>(&'a self, request: &'a VerifyRequest) -> BoxFuture<'a, Verdict> {
        Box::pin(async move {
            self.calls.fetch_add(1, Ordering::SeqCst);
            self.seen.lock().unwrap().push(request.clone());
            let hook = self.hook.lock().unwrap().clone();
            if let Some(hook) = hook {
                hook();
            }
            (self.verdict.lock().unwrap())(request)
        })
    }
}

pub fn assertion(text: &str, source: &str) -> Assertion {
    Assertion { text: text.into(), source: source.into() }
}

/// A well-formed additive draft with the given body, citing the base text and the new note.
pub fn additive(request: &SynthesisRequest, body: &str) -> SynthesisDraft {
    SynthesisDraft {
        kind: request.kind.clone(),
        revised_body: body.into(),
        change: ChangeClass::Additive,
        retained: vec![assertion(&request.base_body, BASE_SOURCE)],
        added: vec![assertion(&request.claim_body, NEW_SOURCE)],
        withdrawn: vec![],
        model: format!("{SYNTH_MODEL}-20260922"),
    }
}
