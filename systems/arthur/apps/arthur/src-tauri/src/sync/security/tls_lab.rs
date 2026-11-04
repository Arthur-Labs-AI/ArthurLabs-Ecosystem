//! TEST-ONLY mutual TLS13/RFC7250 memory lab. Pins are fixture inputs, NOT membership.
//! No sockets, no production TLS configuration and no VerifiedSession constructor.
use super::{
    identity::PublicIdentity,
    tls::{self, CertificateRole},
    Result, SecurityError as E,
};
use crate::storage::tls_identity::OwnedTlsKey;
use rustls::{
    client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier},
    pki_types::{CertificateDer, ServerName, SubjectPublicKeyInfoDer, UnixTime},
    server::danger::{ClientCertVerified, ClientCertVerifier},
    sign::CertifiedKey,
    DigitallySignedStruct, DistinguishedName, SignatureScheme,
};
use std::{fmt, sync::Arc};

struct Pin {
    spki: Vec<u8>,
    role: CertificateRole,
}
impl fmt::Debug for Pin {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("LabPin")
    }
}
fn failure() -> rustls::Error {
    rustls::Error::General("lab_tls_refused".into())
}
impl Pin {
    fn check(
        &self,
        certificate: &CertificateDer<'_>,
        chain: &[CertificateDer<'_>],
    ) -> std::result::Result<(), rustls::Error> {
        if certificate.as_ref() != self.spki || !chain.is_empty() {
            return Err(failure());
        }
        Ok(())
    }
    fn signature(
        &self,
        message: &[u8],
        certificate: &CertificateDer<'_>,
        signature: &DigitallySignedStruct,
    ) -> std::result::Result<HandshakeSignatureValid, rustls::Error> {
        self.check(certificate, &[])?;
        tls::validate_message(self.role, message).map_err(|_| failure())?;
        if signature.scheme != SignatureScheme::ECDSA_NISTP256_SHA256 {
            return Err(failure());
        }
        rustls::crypto::verify_tls13_signature_with_raw_key(
            message,
            &SubjectPublicKeyInfoDer::from(self.spki.as_slice()),
            signature,
            &rustls::crypto::ring::default_provider().signature_verification_algorithms,
        )
    }
}
impl ServerCertVerifier for Pin {
    fn verify_server_cert(
        &self,
        end: &CertificateDer<'_>,
        chain: &[CertificateDer<'_>],
        _: &ServerName<'_>,
        _: &[u8],
        _: UnixTime,
    ) -> std::result::Result<ServerCertVerified, rustls::Error> {
        self.check(end, chain)?;
        Ok(ServerCertVerified::assertion())
    }
    fn verify_tls12_signature(
        &self,
        _: &[u8],
        _: &CertificateDer<'_>,
        _: &DigitallySignedStruct,
    ) -> std::result::Result<HandshakeSignatureValid, rustls::Error> {
        Err(failure())
    }
    fn verify_tls13_signature(
        &self,
        msg: &[u8],
        cert: &CertificateDer<'_>,
        sig: &DigitallySignedStruct,
    ) -> std::result::Result<HandshakeSignatureValid, rustls::Error> {
        self.signature(msg, cert, sig)
    }
    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        vec![SignatureScheme::ECDSA_NISTP256_SHA256]
    }
    fn requires_raw_public_keys(&self) -> bool {
        true
    }
}
impl ClientCertVerifier for Pin {
    fn root_hint_subjects(&self) -> &[DistinguishedName] {
        &[]
    }
    fn verify_client_cert(
        &self,
        end: &CertificateDer<'_>,
        chain: &[CertificateDer<'_>],
        _: UnixTime,
    ) -> std::result::Result<ClientCertVerified, rustls::Error> {
        self.check(end, chain)?;
        Ok(ClientCertVerified::assertion())
    }
    fn verify_tls12_signature(
        &self,
        _: &[u8],
        _: &CertificateDer<'_>,
        _: &DigitallySignedStruct,
    ) -> std::result::Result<HandshakeSignatureValid, rustls::Error> {
        Err(failure())
    }
    fn verify_tls13_signature(
        &self,
        msg: &[u8],
        cert: &CertificateDer<'_>,
        sig: &DigitallySignedStruct,
    ) -> std::result::Result<HandshakeSignatureValid, rustls::Error> {
        self.signature(msg, cert, sig)
    }
    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        vec![SignatureScheme::ECDSA_NISTP256_SHA256]
    }
    fn requires_raw_public_keys(&self) -> bool {
        true
    }
}
pub(crate) struct LabChannel {
    server: PublicIdentity,
    client: PublicIdentity,
    exporter: [u8; 32],
}
pub(crate) enum LabAssurance {
    ObservedKeyPossessionOnly,
}
impl LabChannel {
    // Initial enrollment has no remembered trusted peer pin. Even a correct
    // CertificateVerify against the observed key provides no membership.
    pub fn assurance(&self) -> LabAssurance {
        LabAssurance::ObservedKeyPossessionOnly
    }
    pub fn server(&self) -> &PublicIdentity {
        &self.server
    }
    pub fn client(&self) -> &PublicIdentity {
        &self.client
    }
    pub fn exporter(&self) -> &[u8; 32] {
        &self.exporter
    }
}
fn certified(key: Arc<OwnedTlsKey>) -> Arc<CertifiedKey> {
    Arc::new(CertifiedKey::new(
        vec![CertificateDer::from(tls::spki(key.identity()))],
        key,
    ))
}
pub(crate) fn pair(server: Arc<OwnedTlsKey>, client: Arc<OwnedTlsKey>) -> Result<LabChannel> {
    pair_with_pins(
        server.clone(),
        client.clone(),
        server.identity(),
        client.identity(),
    )
}
pub(crate) fn connections(
    server: Arc<OwnedTlsKey>,
    client: Arc<OwnedTlsKey>,
    server_pin: &PublicIdentity,
    client_pin: &PublicIdentity,
) -> Result<(rustls::ClientConnection, rustls::ServerConnection)> {
    Ok((
        self::client(client, server_pin)?,
        self::server(server, client_pin)?,
    ))
}
pub(crate) fn server(
    key: Arc<OwnedTlsKey>,
    peer: &PublicIdentity,
) -> Result<rustls::ServerConnection> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let mut server_config = rustls::ServerConfig::builder_with_provider(provider.clone())
        .with_protocol_versions(&[&rustls::version::TLS13])
        .map_err(|_| E::Invalid)?
        .with_client_cert_verifier(Arc::new(Pin {
            spki: tls::spki(peer),
            role: CertificateRole::Client,
        }))
        .with_cert_resolver(Arc::new(
            rustls::server::AlwaysResolvesServerRawPublicKeys::new(certified(key)),
        ));
    server_config.send_tls13_tickets = 0;
    server_config.max_early_data_size = 0;
    server_config.alpn_protocols = vec![b"arthur-e3a-lab-v1".to_vec()];
    rustls::ServerConnection::new(Arc::new(server_config)).map_err(|_| E::Trust)
}
pub(crate) fn client(
    key: Arc<OwnedTlsKey>,
    peer: &PublicIdentity,
) -> Result<rustls::ClientConnection> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let mut client_config = rustls::ClientConfig::builder_with_provider(provider)
        .with_protocol_versions(&[&rustls::version::TLS13])
        .map_err(|_| E::Invalid)?
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(Pin {
            spki: tls::spki(peer),
            role: CertificateRole::Server,
        }))
        .with_client_cert_resolver(Arc::new(
            rustls::client::AlwaysResolvesClientRawPublicKeys::new(certified(key)),
        ));
    client_config.resumption = rustls::client::Resumption::disabled();
    client_config.enable_early_data = false;
    client_config.alpn_protocols = vec![b"arthur-e3a-lab-v1".to_vec()];
    rustls::ClientConnection::new(
        Arc::new(client_config),
        ServerName::try_from("arthur.invalid").map_err(|_| E::Invalid)?,
    )
    .map_err(|_| E::Trust)
}

pub(crate) fn pair_with_pins(
    server: Arc<OwnedTlsKey>,
    client: Arc<OwnedTlsKey>,
    server_pin: &PublicIdentity,
    client_pin: &PublicIdentity,
) -> Result<LabChannel> {
    let (mut client_conn, mut server_conn) =
        connections(server.clone(), client.clone(), server_pin, client_pin)?;
    let mut total = 0;
    for _ in 0..32 {
        let mut outbound = Vec::new();
        client_conn.write_tls(&mut outbound).map_err(|_| E::Trust)?;
        total += outbound.len();
        if total > 256 * 1024 {
            return Err(E::Limit);
        }
        if !outbound.is_empty() {
            server_conn
                .read_tls(&mut outbound.as_slice())
                .map_err(|_| E::Trust)?;
            server_conn.process_new_packets().map_err(|_| E::Trust)?;
        }
        let mut outbound = Vec::new();
        server_conn.write_tls(&mut outbound).map_err(|_| E::Trust)?;
        total += outbound.len();
        if total > 256 * 1024 {
            return Err(E::Limit);
        }
        if !outbound.is_empty() {
            client_conn
                .read_tls(&mut outbound.as_slice())
                .map_err(|_| E::Trust)?;
            client_conn.process_new_packets().map_err(|_| E::Trust)?;
        }
        if !client_conn.is_handshaking() && !server_conn.is_handshaking() {
            if client_conn.protocol_version() != Some(rustls::ProtocolVersion::TLSv1_3)
                || server_conn.protocol_version() != Some(rustls::ProtocolVersion::TLSv1_3)
                || client_conn.alpn_protocol() != Some(b"arthur-e3a-lab-v1".as_slice())
                || server_conn.alpn_protocol() != Some(b"arthur-e3a-lab-v1".as_slice())
            {
                return Err(E::Trust);
            }
            let client_export = client_conn
                .export_keying_material([0u8; 32], b"EXPORTER-Channel-Binding", Some(&[]))
                .map_err(|_| E::Trust)?;
            let server_export = server_conn
                .export_keying_material([0u8; 32], b"EXPORTER-Channel-Binding", Some(&[]))
                .map_err(|_| E::Trust)?;
            if client_export != server_export || client_export == [0; 32] {
                return Err(E::Trust);
            }
            return Ok(LabChannel {
                server: server.identity().clone(),
                client: client.identity().clone(),
                exporter: client_export,
            });
        }
    }
    Err(E::Limit)
}
