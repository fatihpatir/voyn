// Supabase Edge Function: send-push
// Deno/TypeScript — Web Push ile VAPID bildirim gönder
// Yeni mesaj veya arama geldiğinde çağrılır

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Web Push için yardımcı fonksiyonlar (web-push kütüphanesi Deno uyumlu versiyonu)
// VAPID imzalama
async function generateVapidAuthHeader(
  audience: string,
  subject: string,
  publicKeyBase64: string,
  privateKeyBase64: string
): Promise<string> {
  const header = { typ: "JWT", alg: "ES256" };
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    aud: audience,
    exp: now + 12 * 60 * 60, // 12 saat
    sub: subject,
  };

  const encodeBase64Url = (data: Uint8Array | string): string => {
    let str: string;
    if (typeof data === "string") str = data;
    else str = String.fromCharCode(...data);
    return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
  };

  const te = new TextEncoder();
  const headerEnc = encodeBase64Url(JSON.stringify(header));
  const payloadEnc = encodeBase64Url(JSON.stringify(payload));
  const sigInput = te.encode(`${headerEnc}.${payloadEnc}`);

  // Private key import
  const privateKeyBytes = Uint8Array.from(
    atob(privateKeyBase64.replace(/-/g, "+").replace(/_/g, "/")),
    (c) => c.charCodeAt(0)
  );

  const privateKey = await crypto.subtle.importKey(
    "pkcs8",
    privateKeyBytes,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"]
  );

  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privateKey,
    sigInput
  );

  const signatureEnc = encodeBase64Url(new Uint8Array(signature));
  const jwt = `${headerEnc}.${payloadEnc}.${signatureEnc}`;

  return `vapid t=${jwt},k=${publicKeyBase64}`;
}

/** Supabase'den kullanıcının push subscription'ını çek */
async function getUserSubscriptions(
  supabase: ReturnType<typeof createClient>,
  userId: string
) {
  const { data, error } = await supabase
    .from("push_subscriptions")
    .select("*")
    .eq("user_id", userId);

  if (error) throw new Error(`Subscription çekme hatası: ${error.message}`);
  return data || [];
}

/** Push bildirimi gönder */
async function sendPushNotification(
  subscription: {
    endpoint: string;
    p256dh: string;
    auth: string;
  },
  payload: string,
  vapidPublicKey: string,
  vapidPrivateKey: string,
  vapidSubject: string
): Promise<{ success: boolean; status?: number; error?: string }> {
  try {
    const url = new URL(subscription.endpoint);
    const audience = `${url.protocol}//${url.host}`;

    const authHeader = await generateVapidAuthHeader(
      audience,
      vapidSubject,
      vapidPublicKey,
      vapidPrivateKey
    );

    // Payload şifreleme (ECDH + AES-GCM)
    const encryptedPayload = await encryptPayload(
      payload,
      subscription.p256dh,
      subscription.auth
    );

    const response = await fetch(subscription.endpoint, {
      method: "POST",
      headers: {
        "Authorization": authHeader,
        "Content-Type": "application/octet-stream",
        "Content-Encoding": "aes128gcm",
        "TTL": "86400",
        "Urgency": "high",
      },
      body: encryptedPayload,
    });

    return { success: response.ok, status: response.status };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

/** AES-GCM ile payload şifreleme (RFC 8291 Web Push Message Encryption) */
async function encryptPayload(
  plaintext: string,
  p256dhBase64: string,
  authBase64: string
): Promise<Uint8Array> {
  const te = new TextEncoder();
  const plaintextBytes = te.encode(plaintext);

  // Alıcı public key
  const receiverPublicKey = await crypto.subtle.importKey(
    "raw",
    base64ToBytes(p256dhBase64),
    { name: "ECDH", namedCurve: "P-256" },
    false,
    []
  );

  // Auth secret
  const authSecret = base64ToBytes(authBase64);

  // Ephemeral key pair oluştur
  const senderKeyPair = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveKey", "deriveBits"]
  );

  // ECDH ile shared secret
  const sharedSecret = await crypto.subtle.deriveBits(
    { name: "ECDH", public: receiverPublicKey },
    senderKeyPair.privateKey,
    256
  );

  // Sender public key bytes
  const senderPublicKeyBytes = new Uint8Array(
    await crypto.subtle.exportKey("raw", senderKeyPair.publicKey)
  );

  // Salt oluştur (16 byte)
  const salt = crypto.getRandomValues(new Uint8Array(16));

  // PRK hesapla (HKDF)
  const authInfo = te.encode("WebPush: info\0");
  const prkInputKeyMaterial = await crypto.subtle.importKey(
    "raw",
    authSecret,
    "HKDF",
    false,
    ["deriveKey", "deriveBits"]
  );

  const sharedSecretKey = await crypto.subtle.importKey(
    "raw",
    sharedSecret,
    "HKDF",
    false,
    ["deriveKey", "deriveBits"]
  );

  // IKM
  const ikmInfo = concatBytes(authInfo, base64ToBytes(p256dhBase64), senderPublicKeyBytes);
  const ikm = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(await crypto.subtle.exportKey("raw", prkInputKeyMaterial)), info: ikmInfo },
    sharedSecretKey,
    256
  );

  // CEK ve Nonce türet
  const ikmKey = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveKey", "deriveBits"]);

  const cekInfo = te.encode("Content-Encoding: aes128gcm\0");
  const nonceInfo = te.encode("Content-Encoding: nonce\0");

  const cekBits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt, info: cekInfo },
    ikmKey,
    128
  );

  const nonceBits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt, info: nonceInfo },
    ikmKey,
    96
  );

  const cek = await crypto.subtle.importKey("raw", cekBits, "AES-GCM", false, ["encrypt"]);

  // Padding ile plaintext hazırla (RFC 8291)
  const record = new Uint8Array(plaintextBytes.length + 1);
  record.set(plaintextBytes);
  record[plaintextBytes.length] = 2; // padding delimiter

  // AES-GCM ile şifrele
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonceBits },
    cek,
    record
  );

  // aes128gcm header + ciphertext
  const header = new Uint8Array(21 + senderPublicKeyBytes.length);
  header.set(salt, 0);                    // salt (16 bytes)
  new DataView(header.buffer).setUint32(16, 4096, false); // rs (record size)
  header[20] = senderPublicKeyBytes.length; // key length
  header.set(senderPublicKeyBytes, 21);

  return concatBytes(header, new Uint8Array(ciphertext));
}

function base64ToBytes(base64: string): Uint8Array {
  const b64 = base64.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(b64);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((acc, a) => acc + a.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}

/* ══════════════════════════ ANA FONKSİYON ════════════════════════════ */

serve(async (req: Request) => {
  // CORS
  if (req.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Authorization, Content-Type",
      },
    });
  }

  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  try {
    // Çevre değişkenleri
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const VAPID_PUBLIC_KEY = Deno.env.get("VAPID_PUBLIC_KEY")!;
    const VAPID_PRIVATE_KEY = Deno.env.get("VAPID_PRIVATE_KEY")!;
    const VAPID_SUBJECT = Deno.env.get("VAPID_SUBJECT") || "mailto:admin@voyn.app";

    if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
      return new Response(
        JSON.stringify({ error: "VAPID anahtarları eksik" }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }

    // Supabase admin client
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    // İstek gövdesini parse et
    const body = await req.json();
    const {
      userId,       // Bildirimin gönderileceği kullanıcı
      title = "VOYN",
      body: msgBody = "Yeni mesaj",
      conversationId,
      senderId,
      senderName,
      messageType = "message",
      icon = "/icons/icon.svg",
      badge = "/icons/icon.svg",
    } = body;

    if (!userId) {
      return new Response(
        JSON.stringify({ error: "userId zorunlu" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    // Kullanıcının subscription'larını al
    const subscriptions = await getUserSubscriptions(supabase, userId);

    if (subscriptions.length === 0) {
      return new Response(
        JSON.stringify({ message: "Kullanıcının aktif subscription'ı yok" }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    // Bildirim payload'ı
    const pushPayload = JSON.stringify({
      title,
      body: msgBody,
      icon,
      badge,
      conversationId,
      senderId,
      senderName,
      messageType,
      url: conversationId ? `/#chat/${conversationId}` : "/",
      tag: `voyn-${conversationId || Date.now()}`,
    });

    // Her subscription'a gönder
    const results = await Promise.allSettled(
      subscriptions.map(async (sub) => {
        const result = await sendPushNotification(
          { endpoint: sub.endpoint, p256dh: sub.p256dh, auth: sub.auth },
          pushPayload,
          VAPID_PUBLIC_KEY,
          VAPID_PRIVATE_KEY,
          VAPID_SUBJECT
        );

        // 404/410 → Süresi dolmuş subscription, sil
        if (result.status === 404 || result.status === 410) {
          await supabase
            .from("push_subscriptions")
            .delete()
            .eq("endpoint", sub.endpoint);
          console.log("[send-push] Süresi dolmuş subscription silindi:", sub.endpoint);
        }

        return { subscriptionId: sub.id, ...result };
      })
    );

    const successful = results.filter(r => r.status === "fulfilled" && (r.value as any).success).length;
    const failed = results.length - successful;

    return new Response(
      JSON.stringify({
        sent: successful,
        failed,
        total: results.length,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );

  } catch (err) {
    console.error("[send-push] Hata:", err);
    return new Response(
      JSON.stringify({ error: String(err) }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
});
