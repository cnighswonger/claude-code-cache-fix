import { X509Certificate } from "node:crypto";

// Does a non-certificate block's armor decode? Node only needs that much from a
// CRL or key block, so this is deliberately weaker than parsing it as whatever
// it claims to be — the guard's job is to predict node's loader, not to
// validate the block's contents.
//
// Base64 is checked as whole 4-character quanta, not merely as an alphabet. An
// alphabet-only test accepted a one-character body: measured, `A` in a
// PUBLIC KEY block ahead of our CA gave guard=accept while node reported
// `bad base64 decode` and loaded zero extra CAs. Padding is equally positional —
// `AAA=` and `AA==` load, `A===`, `=AAA` and `AA=A` do not. Measured 16/16
// agreement with a real handshake on the rule below.
//
// A body containing `-` reads as damaged here even though node accepts it
// (openssl stops at the dash), which is the conservative direction and the only
// measured disagreement.
function isBase64Body(body) {
  const b = body.replace(/\s+/g, "");
  return b.length > 0 && b.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(b);
}

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
  // Trailing whitespace is tolerated on the marker line. openssl still reacts
  // to `-----BEGIN CERTIFICATE----- ` (one trailing space), so a `$`-anchored
  // pattern made that block invisible to us while node still tried to load it
  // — measured: a corrupt block wearing a trailing space was skipped by the
  // guard and failed the handshake.
  // The label pattern is permissive on purpose. Restricting it to uppercase,
  // digits and spaces made every other legal label invisible to us while
  // openssl still treated the block as real — measured: a malformed `X-FOO`
  // block ahead of our CA gave guard=accept while node loaded zero extra CAs.
  // Every label tried behaved as a real block (hyphenated, lowercase,
  // underscored, dotted, punctuated, even empty), so the label decides only
  // WHICH check a block gets, never whether it is one.
  // `-` is legal INSIDE a label, so the stop condition is the `-----` run, not
  // the first hyphen: `[^-]*` failed to match `X-FOO` at all, which is the same
  // blind spot in a new place.
  const marker = /^-----BEGIN ((?:(?!-----).)*)-----[ \t]*$/gm;
  let carriesUs = false;
  for (let m; (m = marker.exec(text)); ) {
    const label = m[1];
    // Bounded by the NEXT marker, not by a search to end-of-file. An unbounded
    // indexOf lets a torn block borrow the END line of a later one, so the
    // unterminated check never fires and the slice spans two entries.
    // The END marker must also END ITS LINE, bar trailing whitespace. indexOf
    // alone ignored whatever followed it, so `-----END CERTIFICATE-----garbage`
    // and `-----END CERTIFICATE-------` both read as terminators here while
    // openssl rejected the block and node loaded zero CAs — measured, both as
    // false accepts on an otherwise healthy bundle. Whitespace is fine (13/13
    // agreement with a real handshake on what may follow), anything else is not.
    const endMarker = `\n-----END ${label}-----`;
    const nextBegin = text.indexOf("\n-----BEGIN ", m.index + 1);
    let end = -1;
    for (let at = text.indexOf(endMarker, m.index); at !== -1;
         at = text.indexOf(endMarker, at + 1)) {
      const lineEnd = text.indexOf("\n", at + 1);
      const tail = text.slice(at + endMarker.length, lineEnd === -1 ? undefined : lineEnd);
      if (/^[ \t\r]*$/.test(tail)) { end = at; break; }
    }
    if (end !== -1 && nextBegin !== -1 && end > nextBegin) end = -1;
    // Unterminated, or closed by a different label. Fatal whatever the label
    // is, and deliberately not analyzed further: openssl's base64 decoder
    // treats the next '-' as end-of-data instead of an error, so a torn block
    // yields a valid entry when its truncated body happens to be a complete
    // DER and garbage when it does not. Measured both outcomes from the same
    // tear position with only the body length changed. Since the result is not
    // knowable from out here, a damaged file is refused rather than guessed at.
    if (end === -1) return { ok: false, reason: `unterminated ${label} block` };
    const block = text.slice(m.index, end + endMarker.length);
    // EVERY block must decode, whatever its label. Node's PEM reader aborts the
    // whole extras load on any block it cannot decode — a truncated CRL or key
    // block ahead of our CA takes the entire file down with it, our own entry
    // included. Skipping non-certificate blocks outright (as this did) waved
    // those bundles through: measured, a corrupt PUBLIC KEY and a corrupt
    // X509 CRL each gave guard=accept while the handshake failed
    // UNABLE_TO_VERIFY_LEAF_SIGNATURE.
    //
    // What "decodes" means differs by label, and both halves were measured
    // against a real handshake rather than reasoned from the spec. For a
    // CERTIFICATE, base64 validity is not enough — a well-formed base64 body
    // that is not a certificate still kills the load, so it must parse as X509.
    // For everything else node only needs the armor to decode, so valid base64
    // is the whole bar; demanding more would reject the CRLs and key blocks a
    // real corporate bundle legitimately carries, and rejecting does not fail
    // safe here — it drops every sibling and corporate CA for the session,
    // which is the failure this contract exists to prevent.
    if (label === "CERTIFICATE") {
      let der;
      try { der = new X509Certificate(block).raw; }
      catch { return { ok: false, reason: "undecodable CERTIFICATE block" }; }
      if (der.equals(ourDer)) carriesUs = true;
    } else if (!isBase64Body(text.slice(m.index + m[0].length, end))) {
      return { ok: false, reason: `undecodable ${label} block` };
    }
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
