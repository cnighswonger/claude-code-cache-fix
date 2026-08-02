import { X509Certificate } from "node:crypto";

// Does a non-certificate block's armor decode? Weaker than parsing it as what
// it claims to be, on purpose: the guard predicts node's loader, it does not
// validate contents. Every clause below was measured against a real handshake.
//
//   whole 4-char quanta, not just the alphabet — a 1-char body loads 0
//   padding is positional — `AAA=` loads, `A===` `=AAA` `AA=A` do not
//   `[ \t\r\n]`, not `\s` — the other ten chars `\s` strips each load 0
//
// A NBSP is what a paste through a rich-text field leaves, so that last one is
// a shape bundles really acquire. A body containing `-` reads as damaged here
// though node accepts it (openssl stops at the dash): conservative, and the
// only measured disagreement.
function isBase64Body(body) {
  const b = body.replace(/[ \t\r\n]+/g, "");
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
  // Every clause defends a measured false accept. Do not tighten one without
  // re-running test/proxy-forward-ca.test.mjs — each was found by a bundle this
  // guard passed and node then refused.
  //
  //   `^`/`/m`   a marker quoted in prose is not a block (`# see -----BEGIN …`)
  //   `[ \t]*`   openssl reacts to a marker wearing a trailing space
  //   `(?!-----)`  labels are near-arbitrary; `-` is legal INSIDE one, so the
  //              stop condition is the dash RUN. `[^-]*` missed `X-FOO` entirely
  //   `.*`       makes a MALFORMED opener visible (`-----BEGIN CERT-------`) so
  //              the per-block checks below can reject it. Without it the block
  //              was skipped and our CA later in the file carried the verdict
  //
  // No CRLF normalization: `$` matches before `\r` and the END search is
  // anchored on `\n`. Measured identical across 102 shapes.
  //
  // The `.*` clause is the END-side defect in its mirror position. A shape fixed
  // at one marker is a shape to go and check at the other; being SEEN is what a
  // guard needs, skipping is what lets a bad block through.
  const marker = /^-----BEGIN ((?:(?!-----).)*)-----[ \t]*.*$/gm;
  let carriesUs = false;
  for (let m; (m = marker.exec(text)); ) {
    const label = m[1];
    // Two measured false accepts, both fixed here: bound the search by the NEXT
    // BEGIN (unbounded, a torn block borrows a later END and spans two entries),
    // and require the END to end its own line bar whitespace (`-----END X-----`
    // followed by garbage or extra dashes read as terminators while node loaded
    // zero CAs).
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
    // Unterminated, or closed by a different label: fatal, and not analyzed
    // further. openssl's decoder treats the next `-` as end-of-data rather than
    // an error, so a tear yields a valid entry or garbage depending only on
    // whether the truncated body happens to be complete DER — measured both from
    // the same tear position. Not knowable from out here, so refuse.
    if (end === -1) return { ok: false, reason: `unterminated ${label} block` };
    const block = text.slice(m.index, end + endMarker.length);
    // EVERY block must decode, whatever its label: node aborts the whole extras
    // load on one it cannot, so a truncated CRL ahead of our CA takes our own
    // entry down with it. Skipping non-certificate blocks waved exactly those
    // bundles through — measured, guard=accept and the handshake failed.
    //
    // The BAR differs by label, both halves measured. CERTIFICATE must parse as
    // X509: valid base64 that is not a cert still kills the load. Everything
    // else needs only decodable armor — demanding more rejects the CRLs and key
    // blocks a real corporate bundle carries, and rejecting is not the safe
    // direction here, it drops every sibling CA for the session.
    if (label === "CERTIFICATE") {
      let der;
      try { der = new X509Certificate(block).raw; }
      catch { return { ok: false, reason: "undecodable CERTIFICATE block" }; }
      if (der.equals(ourDer)) carriesUs = true;
    } else if (!isBase64Body(text.slice(m.index + m[0].length, end))) {
      return { ok: false, reason: `undecodable ${label} block` };
    }
  }
  // A bundle that predates our publish is WORSE than no bundle: it makes the
  // client distrust the very proxy it is routed through, failing every request
  // rather than losing one component's CA.
  //
  // On DER and only on a CERTIFICATE block, both load-bearing: relabelling our
  // CA to TRUSTED CERTIFICATE gives byte-identical DER while node's loader skips
  // it entirely — measured as an accept whose handshake then failed.
  return carriesUs ? { ok: true } : { ok: false, reason: "bundle does not carry our CA" };
}
