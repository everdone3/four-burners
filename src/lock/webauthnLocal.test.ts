// Local WebAuthn verification (webauthnLocal.ts), with Node's WebCrypto (globalThis.crypto).
// The lock is an access gate, not encryption: see the header of webauthnLocal.ts.
// 1) W3C WebAuthn L3 official test vectors (ES256 none, Apple anonymous, packed RS256)
// 2) Freshly generated P-256 and RSA keys acting as a fake authenticator
// 3) Negative cases: every check must be able to fail on its own
import { describe, expect, it } from 'vitest';
import {
  base64urlDecode,
  base64urlEncode,
  concatBytes,
  derToRaw,
  newChallenge,
  parseAttestation,
  publicKeyFromAttestation,
  verifyAssertion,
  verifyRegistration,
  COSE_ALG_ES256,
  COSE_ALG_RS256,
  type AssertionCredentialLike,
  type StoredPasskey,
  type SupportedAlg,
  type VerifyAssertionOptions,
} from './webauthnLocal';

type Bytes = Uint8Array<ArrayBuffer>;
const enc = new TextEncoder();
const hex = (h: string): Bytes => {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
};
const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const ab = (b: Uint8Array): ArrayBuffer => b.slice().buffer as ArrayBuffer;
const sha256 = async (b: Uint8Array) => new Uint8Array(await crypto.subtle.digest('SHA-256', b.slice()));

// ---- test-only: raw r||s -> DER (what a real authenticator emits) ----
function rawToDer(raw: Uint8Array): Bytes {
  const int = (v: Uint8Array) => {
    let i = 0;
    while (i < v.length - 1 && v[i] === 0) i++;
    let b = v.slice(i);
    if (b[0] & 0x80) b = concatBytes(new Uint8Array([0]), b);
    return concatBytes(new Uint8Array([0x02, b.length]), b);
  };
  const body = concatBytes(int(raw.subarray(0, 32)), int(raw.subarray(32)));
  return concatBytes(new Uint8Array([0x30, body.length]), body);
}

// ---- test-only: tiny CBOR encoder to build fake attestationObjects ----
function cborHead(major: number, n: number): Bytes {
  if (n < 24) return new Uint8Array([(major << 5) | n]);
  if (n < 0x100) return new Uint8Array([(major << 5) | 24, n]);
  if (n < 0x10000) return new Uint8Array([(major << 5) | 25, n >> 8, n & 0xff]);
  return new Uint8Array([(major << 5) | 26, n >>> 24, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]);
}
type Enc = number | string | Uint8Array | Enc[] | Map<number | string, Enc>;
function cbor(v: Enc): Bytes {
  if (typeof v === 'number') return v >= 0 ? cborHead(0, v) : cborHead(1, -1 - v);
  if (typeof v === 'string') {
    const b = enc.encode(v);
    return concatBytes(cborHead(3, b.length), b);
  }
  if (v instanceof Uint8Array) return concatBytes(cborHead(2, v.length), v);
  if (Array.isArray(v)) return concatBytes(cborHead(4, v.length), ...v.map(cbor));
  const parts: Uint8Array[] = [cborHead(5, v.size)];
  for (const [k, val] of v) parts.push(cbor(k), cbor(val));
  return concatBytes(...parts);
}

// ---- fake authenticator ----
interface FakeAuth {
  alg: SupportedAlg;
  keys: CryptoKeyPair;
  credId: Bytes;
}
async function makeAuth(alg: SupportedAlg): Promise<FakeAuth> {
  const keys = (alg === COSE_ALG_ES256
    ? await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
    : await crypto.subtle.generateKey(
        { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
        true,
        ['sign', 'verify'],
      )) as CryptoKeyPair;
  return { alg, keys, credId: crypto.getRandomValues(new Uint8Array(16)) };
}
async function coseKeyOf(a: FakeAuth): Promise<Bytes> {
  const jwk = await crypto.subtle.exportKey('jwk', a.keys.publicKey);
  const m = new Map<number | string, Enc>();
  if (a.alg === COSE_ALG_ES256) {
    m.set(1, 2);
    m.set(3, -7);
    m.set(-1, 1);
    m.set(-2, base64urlDecode(jwk.x!));
    m.set(-3, base64urlDecode(jwk.y!));
  } else {
    m.set(1, 3);
    m.set(3, -257);
    m.set(-1, base64urlDecode(jwk.n!));
    m.set(-2, base64urlDecode(jwk.e!));
  }
  return cbor(m);
}
async function authData(rpId: string, flags: number, signCount: number, attested?: Uint8Array): Promise<Bytes> {
  const cnt = new Uint8Array(4);
  new DataView(cnt.buffer).setUint32(0, signCount);
  return concatBytes(await sha256(enc.encode(rpId)), new Uint8Array([flags]), cnt, attested ?? new Uint8Array(0));
}
async function sign(a: FakeAuth, data: Uint8Array): Promise<Bytes> {
  if (a.alg === COSE_ALG_ES256) {
    const raw = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, a.keys.privateKey, data.slice()));
    return rawToDer(raw); // WebCrypto signs P1363; authenticators send DER
  }
  return new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', a.keys.privateKey, data.slice()));
}
async function makeAssertion(
  a: FakeAuth,
  o: { rpId: string; origin: string; challenge: Uint8Array; flags: number; signCount?: number; type?: string; extraJson?: string },
): Promise<AssertionCredentialLike> {
  const cData = enc.encode(
    `{"type":"${o.type ?? 'webauthn.get'}","challenge":"${base64urlEncode(o.challenge)}","origin":"${o.origin}","crossOrigin":false${o.extraJson ?? ''}}`,
  );
  const ad = await authData(o.rpId, o.flags, o.signCount ?? 0);
  const sig = await sign(a, concatBytes(ad, await sha256(cData)));
  return { rawId: ab(a.credId), response: { clientDataJSON: ab(cData), authenticatorData: ab(ad), signature: ab(sig), userHandle: null } };
}
function mutate(c: AssertionCredentialLike, field: 'authenticatorData' | 'clientDataJSON' | 'signature', idx: number): AssertionCredentialLike {
  const b = new Uint8Array(c.response[field].slice(0));
  b[idx] ^= 0x01;
  return { ...c, response: { ...c.response, [field]: b.buffer } };
}

describe('derToRaw', () => {
  // Example from WebAuthn L3 section 6.5.5 (33-byte r with 0x00 pad, 30-byte s)
  const specDer = hex(
    '3043022100899095' +
      '04e14f1e29dba8158fa7c387e888ffbe07d824bb2143205506ab159c3e' +
      '021e56554fb5819b12845e85be2f78371cf3cb95e387f451cb362b9478d183d2',
  );

  it('converts the spec example to 64 bytes, stripping and padding as needed', () => {
    const raw = derToRaw(specDer);
    expect(raw.length).toBe(64);
    expect(toHex(raw.subarray(0, 32))).toBe('89909504e14f1e29dba8158fa7c387e888ffbe07d824bb2143205506ab159c3e');
    expect(toHex(raw.subarray(32))).toBe('000056554fb5819b12845e85be2f78371cf3cb95e387f451cb362b9478d183d2');
  });

  it('rejects trailing garbage and raw (non-DER) signatures', () => {
    expect(() => derToRaw(concatBytes(specDer, new Uint8Array([0])))).toThrow();
    expect(() => derToRaw(derToRaw(specDer))).toThrow();
  });

  it('is required: DER straight into subtle.verify silently fails, converted verifies', async () => {
    const kp = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify'])) as CryptoKeyPair;
    const msg = enc.encode('hello');
    const p1363 = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, kp.privateKey, msg));
    const der = rawToDer(p1363);
    const alg = { name: 'ECDSA', hash: 'SHA-256' };
    expect(await crypto.subtle.verify(alg, kp.publicKey, der, msg)).toBe(false);
    expect(await crypto.subtle.verify(alg, kp.publicKey, derToRaw(der), msg)).toBe(true);
  });
});

describe('W3C WebAuthn L3 test vectors (rpId example.org)', () => {
  const vectors: Array<{ name: string; attObj: string; regChallenge: string; regCData: string; credId: string; authData: string; cData: string; challenge: string; sig: string }> = [
    {
      name: 'none.ES256',
      regChallenge: '00c30fb78531c464d2b6771dab8d7b603c01162f2fa486bea70f283ae556e130',
      regCData: '7b2274797065223a22776562617574686e2e637265617465222c226368616c6c656e6765223a22414d4d507434557878475453746e63647134313759447742466938767049612d7077386f4f755657345441222c226f726967696e223a2268747470733a2f2f6578616d706c652e6f7267222c2263726f73734f726967696e223a66616c73652c22657874726144617461223a22636c69656e74446174614a534f4e206d617920626520657874656e6465642077697468206164646974696f6e616c206669656c647320696e20746865206675747572652c207375636820617320746869733a20426b5165446a646354427258426941774a544c453551227d',
      attObj: 'a363666d74646e6f6e656761747453746d74a068617574684461746158a4bfabc37432958b063360d3ad6461c9c4735ae7f8edd46592a5e0f01452b2e4b559000000008446ccb9ab1db374750b2367ff6f3a1f0020f91f391db4c9b2fde0ea70189cba3fb63f579ba6122b33ad94ff3ec330084be4a5010203262001215820afefa16f97ca9b2d23eb86ccb64098d20db90856062eb249c33a9b672f26df61225820930a56b87a2fca66334b03458abf879717c12cc68ed73290af2e2664796b9220',
      credId: 'f91f391db4c9b2fde0ea70189cba3fb63f579ba6122b33ad94ff3ec330084be4',
      challenge: '39c0e7521417ba54d43e8dc95174f423dee9bf3cd804ff6d65c857c9abf4d408',
      authData: 'bfabc37432958b063360d3ad6461c9c4735ae7f8edd46592a5e0f01452b2e4b51900000000',
      cData: '7b2274797065223a22776562617574686e2e676574222c226368616c6c656e6765223a224f63446e55685158756c5455506f334a5558543049393770767a7a59425039745a63685879617630314167222c226f726967696e223a2268747470733a2f2f6578616d706c652e6f7267222c2263726f73734f726967696e223a66616c73657d',
      sig: '3046022100f50a4e2e4409249c4a853ba361282f09841df4dd4547a13a87780218deffcd380221008480ac0f0b93538174f575bf11a1dd5d78c6e486013f937295ea13653e331e87',
    },
    {
      name: 'apple.ES256',
      regChallenge: 'f7f688213852007775009cf8c096fda89d60b9a9fb5a50dd81dd9898af5a0609',
      regCData: '7b2274797065223a22776562617574686e2e637265617465222c226368616c6c656e6765223a22395f61494954685341486431414a7a34774a6239714a316775616e37576c4464676432596d4b396142676b222c226f726967696e223a2268747470733a2f2f6578616d706c652e6f7267222c2263726f73734f726967696e223a66616c73652c22657874726144617461223a22636c69656e74446174614a534f4e206d617920626520657874656e6465642077697468206164646974696f6e616c206669656c647320696e20746865206675747572652c207375636820617320746869733a20546a4c506e704f6158515572464e6362483274545a41227d',
      attObj: 'a363666d74656170706c656761747453746d74a1637835638159025c30820258308201fea0030201020210394275613d5310b81a29ce90f48b61c1300a06082a8648ce3d0403023062311e301c06035504030c15576562417574686e207465737420766563746f7273310c300a060355040a0c0357334331253023060355040b0c1c41757468656e74696361746f72204174746573746174696f6e204341310b30090603550406130241413020170d3234303130313030303030305a180f33303234303130313030303030305a305f311e301c06035504030c15576562417574686e207465737420766563746f7273310c300a060355040a0c0357334331223020060355040b0c1941757468656e74696361746f72204174746573746174696f6e310b30090603550406130241413059301306072a8648ce3d020106082a8648ce3d030107034200048a3d5b1b4c543a706bf6e4b00afedb3c930b690dd286934fe2911f779cc7761af728e1aa3b0ff66692192daa776b83ddf8e3340d2d9a0eabdfc324eb3e2f136ca38196308193300c0603551d130101ff04023000300e0603551d0f0101ff040403020780301d0603551d0e0416041412f1ce6c0ae39b403bfc9200317bc183a4e4d766301f0603551d2304183016801445aff715b0dd786741fee996ebc16547a3931b1e303306092a864886f76364080204263024a1220420d7a86e7233fb843eb0eeb407d8b76ff7e4f82d218cf5dbb461d752073f5cb29a300a06082a8648ce3d0403020348003045022070f5c2ede3000e9dae358d412b26a4acbf18f4cdeb80f5b13fcd564d090c39ec022100f672e2c3dbe117c9b1490b3c660abf5dcd74398187082dacb58b6744de4aca6068617574684461746158a4bfabc37432958b063360d3ad6461c9c4735ae7f8edd46592a5e0f01452b2e4b54900000000748210a20076616a733b2114336fc38400209c4a5886af9283d9be3e9ec55978dedfdce2e3b365cab193ae850c16238fafb8a50102032620012158208a3d5b1b4c543a706bf6e4b00afedb3c930b690dd286934fe2911f779cc7761a225820f728e1aa3b0ff66692192daa776b83ddf8e3340d2d9a0eabdfc324eb3e2f136c',
      credId: '9c4a5886af9283d9be3e9ec55978dedfdce2e3b365cab193ae850c16238fafb8',
      challenge: 'd3eb2964641e26fed023403a72dde093b19c4ba9008c3f9dd83fcfd347a66d05',
      authData: 'bfabc37432958b063360d3ad6461c9c4735ae7f8edd46592a5e0f01452b2e4b50900000000',
      cData: '7b2274797065223a22776562617574686e2e676574222c226368616c6c656e6765223a22302d73705a4751654a76375149304136637433676b37476353366b416a442d6432445f503030656d625155222c226f726967696e223a2268747470733a2f2f6578616d706c652e6f7267222c2263726f73734f726967696e223a66616c73657d',
      sig: '3046022100ee35db795ce28044e1f8231d68b3d79a9882f7415aa35c1b5ac74d24251073c8022100dcc65691650a412d0ceef843710c09827acf26c7845bddac07eec95863e7fc4c',
    },
    {
      name: 'packed.RS256',
      regChallenge: 'bea8f0770009bd57f2c0df6fea9f743a27e4b61bbe923c862c7aad7a9fc8e4a6',
      regCData: '7b2274797065223a22776562617574686e2e637265617465222c226368616c6c656e6765223a2276716a776477414a76566679774e3976367039304f69666b7468752d6b6a79474c48717465705f49354b59222c226f726967696e223a2268747470733a2f2f6578616d706c652e6f7267222c2263726f73734f726967696e223a66616c73657d',
      attObj: 'a363666d74667061636b65646761747453746d74a363616c672663736967584730450221008b8c5c6ea8c142c032e0be69e1353d44461c5c9109941cdda951b976eb95b6b302204d52f406c19e254b3ff9589bd18070fb055ac8db12fdd0a6734bea9d7168e900637835638159022630820222308201c7a00302010202101f6fb7a5ece81b45896b983a995da5f3300a06082a8648ce3d0403023062311e301c06035504030c15576562417574686e207465737420766563746f7273310c300a060355040a0c0357334331253023060355040b0c1c41757468656e74696361746f72204174746573746174696f6e204341310b30090603550406130241413020170d3234303130313030303030305a180f33303234303130313030303030305a305f311e301c06035504030c15576562417574686e207465737420766563746f7273310c300a060355040a0c0357334331223020060355040b0c1941757468656e74696361746f72204174746573746174696f6e310b30090603550406130241413059301306072a8648ce3d020106082a8648ce3d03010703420004b7b36b7542a11120b443c794d0c99fdc25a06b76586413d81e086163ef6fe147a557afc34e2861d9057d6d465d4705a0310550bdeeb5f35ee35b9425ab859981a360305e300c0603551d130101ff04023000300e0603551d0f0101ff040403020780301d0603551d0e04160414fb37b647bccfb9e54d989eaaacc1633868703fb3301f0603551d2304183016801445aff715b0dd786741fee996ebc16547a3931b1e300a06082a8648ce3d0403020349003046022100b86bc129d92afca7d9869a39f70f139a305b4073a39eb654d81424bed5757d91022100cf9f7c60cab7c4a7d3e7f0020f281a93d4fd0a9f95121b989f56932a68885fba68617574684461746159021bbfabc37432958b063360d3ad6461c9c4735ae7f8edd46592a5e0f01452b2e4b55d00000000428f8878298b9862a36ad8c7527bfef20020992a18acc83f67533600c1138a4b4c4bd236de13629cf025ed17cb00b00b74dfa4010303390100205901b403fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff800000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000012143010001',
      credId: '992a18acc83f67533600c1138a4b4c4bd236de13629cf025ed17cb00b00b74df',
      challenge: '295f59f5fa8fe62c5aca9e27626c78c8da376ae6d8cd2dd29aebad601e1bc4c5',
      authData: 'bfabc37432958b063360d3ad6461c9c4735ae7f8edd46592a5e0f01452b2e4b51900000000',
      cData: '7b2274797065223a22776562617574686e2e676574222c226368616c6c656e6765223a224b56395a39667150356978617970346e596d7834794e6f33617562597a5333536d75757459423462784d55222c226f726967696e223a2268747470733a2f2f6578616d706c652e6f7267222c2263726f73734f726967696e223a66616c73657d',
      sig: '01063d52d7c39b4d432fc7063c5d93e582bdcb16889cd71f888d67d880ea730a428498d3bc8e1ee11f2b1ecbe6c292b118c55ffaaddefa8cad0a54dd137c51f1eec673f1bb6c4d1789d6826a222b22d0f585fc901fdc933212e579d199b89d672aa44891333e6a1355536025e82b25590256c3538229b55737083b2f6b9377e49e2472f11952f79fdd0da180b5ffd901b4049a8f081bb40711bef76c62aed943571f2d0575304cb549d68d8892f95086a30f93716aee818f8dc06e96c0d5e0ed4cfa9fd8773d90464b68cf140f7986666ff9c9e3302acd0535d60d769f465e2ab57ef8aabc89fccfef7ba32a64154a8b3d26be2298f470b8cc5377dbe3dfd4b0b45f8f01e63bde6cfc76b62771f9b70aa27cf40152cad93aa5acd784fd4b90f676e2ea828d0bf2400aebbaae4153e5838f537f88b6228346782a93a899be66ec77de45b3efcf311da6321c92e6b0cd11bfe653bf3e98cee8e341f02d67dbb6f9c98d9e8178090cfb5b70fbc6d541599ac794ae2f1d4de1286ec8de8c2daf7b1d15c8438e90d924df5c19045220a4c8438c1b979bbe016cf3d0eeec23c3999d4882cc645b776de930756612cdc6dd398160ff02a6',
    },
  ];

  it.each(vectors)('$name: parses, enrols via the CBOR path, and verifies', async (v) => {
    const att = parseAttestation(hex(v.attObj));
    expect(toHex(att.credentialId)).toBe(v.credId);
    // Full enrolment path via the attestationObject fallback (no getPublicKey on this object)
    const stored = await verifyRegistration(
      { rawId: ab(hex(v.credId)), response: { clientDataJSON: ab(hex(v.regCData)), attestationObject: ab(hex(v.attObj)) } },
      { challenge: hex(v.regChallenge), origin: 'https://example.org', rpId: 'example.org', requireUserVerification: false },
    );
    const cred: AssertionCredentialLike = {
      rawId: ab(hex(v.credId)),
      response: { clientDataJSON: ab(hex(v.cData)), authenticatorData: ab(hex(v.authData)), signature: ab(hex(v.sig)) },
    };
    const base = { expectedChallenge: hex(v.challenge), expectedOrigin: 'https://example.org', expectedRpId: 'example.org', stored };
    const r1 = await verifyAssertion(cred, { ...base, requireUserVerification: false });
    expect(r1.ok, JSON.stringify(r1)).toBe(true);
    // These vectors have flags 0x19/0x09 (UV clear), so requiring UV must fail.
    expect(await verifyAssertion(cred, base)).toEqual({ ok: false, reason: 'UV flag not set' });
    const r3 = await verifyAssertion(mutate(cred, 'signature', 10), { ...base, requireUserVerification: false });
    expect(r3.ok).toBe(false);
  });
});

const RP = 'four-burners.vercel.app';
const ORIGIN = 'https://four-burners.vercel.app';
const APPLE_FLAGS = 0x1d; // UP|UV|BE|BS: what an iCloud Keychain passkey with Face ID reports

describe.each([
  { label: 'ES256/P-256', alg: COSE_ALG_ES256 as SupportedAlg },
  { label: 'RS256/RSA-2048', alg: COSE_ALG_RS256 as SupportedAlg },
])('generated $label authenticator (rpId four-burners.vercel.app)', ({ alg }) => {
  async function enrol() {
    const a = await makeAuth(alg);
    const regChallenge = newChallenge();
    const attested = concatBytes(new Uint8Array(16), new Uint8Array([0, a.credId.length]), a.credId, await coseKeyOf(a));
    const regAuthData = await authData(RP, APPLE_FLAGS | 0x40, 0, attested);
    const attObj = cbor(new Map<string, Enc>([['fmt', 'none'], ['attStmt', new Map()], ['authData', regAuthData]]));
    const regCData = enc.encode(`{"type":"webauthn.create","challenge":"${base64urlEncode(regChallenge)}","origin":"${ORIGIN}","crossOrigin":false}`);
    const spki = new Uint8Array(await crypto.subtle.exportKey('spki', a.keys.publicKey));
    return { a, regChallenge, regAuthData, attObj, regCData, spki };
  }

  it('takes the key from getPublicKey() when available and falls back to CBOR otherwise', async () => {
    const { attObj, regCData, spki } = await enrol();
    const viaSpki = await publicKeyFromAttestation({
      clientDataJSON: ab(regCData),
      attestationObject: ab(attObj),
      getPublicKey: () => ab(spki),
      getPublicKeyAlgorithm: () => alg,
    });
    const viaNull = await publicKeyFromAttestation({
      clientDataJSON: ab(regCData),
      attestationObject: ab(attObj),
      getPublicKey: () => null,
      getPublicKeyAlgorithm: () => alg,
    });
    const viaMissing = await publicKeyFromAttestation({ clientDataJSON: ab(regCData), attestationObject: ab(attObj) });
    expect(viaSpki.source).toBe('getPublicKey');
    expect(viaNull.source).toBe('attestationObject');
    expect(viaMissing.source).toBe('attestationObject');
    // COSE->JWK must describe the same key as the SPKI: re-export both as SPKI and compare
    const reSpki = async (jwk: JsonWebKey) => {
      const params = alg === COSE_ALG_ES256 ? { name: 'ECDSA', namedCurve: 'P-256' } : { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' };
      const k = await crypto.subtle.importKey('jwk', jwk, params, true, ['verify']);
      return toHex(new Uint8Array(await crypto.subtle.exportKey('spki', k)));
    };
    expect(await reSpki(viaNull.jwk)).toBe(toHex(spki));
    expect(await reSpki(viaSpki.jwk)).toBe(toHex(spki));
  });

  it('enrols, unlocks, and rejects every tampered or foreign assertion', async () => {
    const { a, regChallenge, regAuthData, attObj, regCData, spki } = await enrol();
    const stored: StoredPasskey = await verifyRegistration(
      {
        rawId: ab(a.credId),
        response: {
          clientDataJSON: ab(regCData),
          attestationObject: ab(attObj),
          getPublicKey: () => ab(spki),
          getPublicKeyAlgorithm: () => alg,
          getAuthenticatorData: () => ab(regAuthData),
        },
      },
      { challenge: regChallenge, origin: ORIGIN, rpId: RP },
    );
    expect(stored.alg).toBe(alg);
    expect(stored.backupEligible).toBe(true);
    expect(stored.signCount).toBe(0);

    const challenge = newChallenge();
    const good = await makeAssertion(a, { rpId: RP, origin: ORIGIN, challenge, flags: APPLE_FLAGS });
    const opts: VerifyAssertionOptions = { expectedChallenge: challenge, expectedOrigin: ORIGIN, expectedRpId: RP, stored };
    const ok = await verifyAssertion(good, opts);
    expect(ok.ok && !ok.counterWentBackwards, JSON.stringify(ok)).toBe(true);
    const viaNull = await publicKeyFromAttestation({ clientDataJSON: ab(regCData), attestationObject: ab(attObj) });
    expect((await verifyAssertion(good, { ...opts, stored: { ...stored, publicKeyJwk: viaNull.jwk } })).ok).toBe(true);

    const expectFail = async (cred: AssertionCredentialLike, o: VerifyAssertionOptions, reason?: string) => {
      const r = await verifyAssertion(cred, o);
      expect(r.ok, JSON.stringify(r)).toBe(false);
      if (reason !== undefined && !r.ok) expect(r.reason).toBe(reason);
    };
    const variant = (o: Partial<{ rpId: string; origin: string; flags: number; type: string; extraJson: string }>) =>
      makeAssertion(a, { rpId: RP, origin: ORIGIN, challenge, flags: APPLE_FLAGS, ...o });

    await expectFail(good, { ...opts, expectedChallenge: newChallenge() }, 'challenge mismatch');
    await expectFail(await variant({ type: 'webauthn.create' }), opts, 'clientData.type is not webauthn.get');
    await expectFail(await variant({ origin: 'https://four-burners-git-dev.vercel.app' }), opts, 'origin mismatch');
    await expectFail(await variant({ rpId: 'vercel.app' }), opts, 'rpIdHash mismatch');
    await expectFail(await variant({ flags: APPLE_FLAGS & ~0x01 }), opts, 'UP flag not set');
    await expectFail(await variant({ flags: APPLE_FLAGS & ~0x04 }), opts, 'UV flag not set');
    await expectFail(await variant({ flags: 0x15 }), opts, 'BS set without BE');
    await expectFail(await variant({ extraJson: ',"topOrigin":"https://evil.example"' }), opts, 'unexpected cross-origin use');
    await expectFail(mutate(good, 'authenticatorData', 33), opts, 'bad signature');
    {
      const cd = new Uint8Array(good.response.clientDataJSON);
      const padded = concatBytes(cd, enc.encode(' ')); // still valid JSON, same fields
      await expectFail({ ...good, response: { ...good.response, clientDataJSON: ab(padded) } }, opts, 'bad signature');
    }
    await expectFail(mutate(good, 'signature', 12), opts);
    const other = await makeAuth(alg);
    const forged = await makeAssertion(other, { rpId: RP, origin: ORIGIN, challenge, flags: APPLE_FLAGS });
    await expectFail({ ...forged, rawId: good.rawId }, opts, 'bad signature');
    await expectFail(forged, opts, 'unknown credential');
    await expectFail({ ...good, response: { ...good.response, signature: ab(new Uint8Array([1, 2, 3])) } }, opts);

    // signCount: surfaced, never enforced
    const c5 = await makeAssertion(a, { rpId: RP, origin: ORIGIN, challenge, flags: 0x05, signCount: 5 });
    const r5 = await verifyAssertion(c5, { ...opts, stored: { ...stored, signCount: 4 } });
    expect(r5.ok && r5.signCount === 5 && !r5.counterWentBackwards).toBe(true);
    const r6 = await verifyAssertion(c5, { ...opts, stored: { ...stored, signCount: 9 } });
    expect(r6.ok && r6.counterWentBackwards).toBe(true);
  });
});
