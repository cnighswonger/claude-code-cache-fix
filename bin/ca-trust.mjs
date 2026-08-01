import { X509Certificate } from "node:crypto";

// Is this merged CA bundle safe to hand claude as NODE_EXTRA_CA_CERTS?
//
// Lives in its own module for one reason: the launcher is a top-level script,
// so a test could not import this decision and the previous version kept a
// hand-copied duplicate in test/proxy-forward-ca.test.mjs under a "change one,
// change both" comment. Measured: mutating the launcher's copy left the whole
// suite green, so the trust path had no regression cover at all. Two call sites
// is below this repo's bar for a new abstraction; the justification here is not
// reuse, it is that the test must drive the shipped code rather than an
// adjacent copy of it.
//
// The rule this implements is node's, not openssl's-in-general, and every
// clause below was measured against a real TLS handshake (node v24.11.1,
// openssl 3.6.1) rather than reasoned from the spec. See
// test/proxy-forward-ca.test.mjs, which re-runs that comparison on each shape.
//
// It stays a pre-flight guard, never proof: it establishes the file parses and
// carries us, never that node will verify a given leaf with it.
export function bundleCarriesOurCA(text, ourCaPem) {
  const ourDer = new X509Certificate(ourCaPem).raw;
  // Line-anchored. openssl only honours a marker that begins a line, so a
  // marker quoted inside prose is not a block. The previous count-based check
  // read the raw file and rejected any bundle whose provenance header happened
  // to name the marker — measured: `# see -----BEGIN CERTIFICATE-----` ahead of
  // a healthy CA was refused while node authorized the same bytes.
  //
  // No CRLF normalization: `$` in a /m regex matches before a `\r`, and the END
  // search below is anchored on the leading `\n`, so both halves already read a
  // CRLF file the same as an LF one. Measured across 102 shapes (34 bundle
  // layouts x LF/CRLF/mixed): identical verdicts with and without the replace.
  const marker = /^-----BEGIN ([A-Z0-9 ]*)-----$/gm;
  let carriesUs = false;
  for (let m; (m = marker.exec(text)); ) {
    const label = m[1];
    const endMarker = `\n-----END ${label}-----`;
    const end = text.indexOf(endMarker, m.index);
    // Unterminated, or closed by a different label. Fatal whatever the label
    // is, and deliberately not analyzed further: openssl's base64 decoder
    // treats the next '-' as end-of-data instead of an error, so a torn block
    // yields a valid entry when its truncated body happens to be a complete
    // DER and garbage when it does not. Measured both outcomes from the same
    // tear position with only the body length changed. Since the result is not
    // knowable from out here, a damaged file is refused rather than guessed at.
    if (end === -1) return { ok: false, reason: `unterminated ${label} block` };
    // Everything else in the file is node's business, not ours. A merged bundle
    // legitimately carries CRLs, public keys and key material alongside the
    // roots; node's loader skips them and verifies fine. Parsing every block as
    // a certificate is what made those bundles unusable — and rejecting the
    // bundle does not fail safe, it drops every sibling and corporate CA for
    // the whole session, which is the failure this contract exists to prevent.
    if (label !== "CERTIFICATE") continue;
    const block = text.slice(m.index, end + endMarker.length);
    let der;
    try { der = new X509Certificate(block).raw; }
    catch { return { ok: false, reason: "undecodable CERTIFICATE block" }; }
    if (der.equals(ourDer)) carriesUs = true;
  }
  // A bundle that exists but predates our publish is WORSE than no bundle:
  // handing it to claude makes the client distrust the very proxy it is routed
  // through, so every request fails TLS rather than merely losing some other
  // component's CA.
  //
  // Matched on DER, and only on a CERTIFICATE block, because neither weaker
  // check is sound. Measured: relabelling our own CA to TRUSTED CERTIFICATE
  // leaves X509Certificate parsing it into byte-identical DER while node's CA
  // loader skips it entirely — the old guard accepted that bundle and the
  // handshake then failed with UNABLE_TO_VERIFY_LEAF_SIGNATURE. That is the
  // exact outcome this check exists to prevent, so the label is load-bearing.
  return carriesUs ? { ok: true } : { ok: false, reason: "bundle does not carry our CA" };
}
