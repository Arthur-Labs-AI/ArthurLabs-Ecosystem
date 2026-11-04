use std::future::Future;
use std::pin::Pin;

/// Boxed future used by the object-safe recorder and transcriber traits.
pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;
