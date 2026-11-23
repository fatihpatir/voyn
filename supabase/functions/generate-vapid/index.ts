// Supabase Edge Function: generate-vapid
// Deno/TypeScript — VAPID anahtar çifti üret
// Sadece admin token ile çağrılabilir

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

/** ECDH P-256 key pair'den VAPID formatında base64url anahtarlar üret */
async function generateVapidKeys(): Promise<{
  publicKey: string;
  privateKey: string;
  publicKeyUncompressed: string;
}> {
  // P-256 eğrisi üzerinde ECDSA key pair oluştur (VAPID için ECDH uyumlu)
  const keyPair = await crypto.subtle.generateKey(
    {
      name: "ECDSA",
      namedCurve: "P-256",
    },
    true, // extractable
    ["sign", "verify"]
  );

  // Public key — raw format (65 byte uncompressed: 0x04 + x + y)
  const publicKeyRaw = await crypto.subtle.exportKey("raw", keyPair.publicKey);

  // Private key — PKCS8 format
  const privateKeyPkcs8 = await crypto.subtle.exportKey("pkcs8", keyPair.privateKey);

  const toBase64Url = (buffer: ArrayBuffer): string => {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    bytes.forEach((b) => (binary += String.fromCharCode(b)));
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
  };

  // Web Push standardı: public key ham (65 byte), private key PKCS8
  const publicKeyB64 = toBase64Url(publicKeyRaw);
  const privateKeyB64 = toBase64Url(privateKeyPkcs8);

  // Sadece uncompressed public key (bazı araçlar için)
  return {
    publicKey: publicKeyB64,
    privateKey: privateKeyB64,
    publicKeyUncompressed: publicKeyB64,
  };
}

/** Mevcut VAPID anahtarlarını doğrula */
async function validateVapidKey(publicKeyBase64: string): Promise<boolean> {
  try {
    const bytes = Uint8Array.from(
      atob(publicKeyBase64.replace(/-/g, "+").replace(/_/g, "/")),
      (c) => c.charCodeAt(0)
    );

    // P-256 uncompressed key 65 byte olmalı (0x04 prefix)
    if (bytes.length !== 65 || bytes[0] !== 0x04) return false;

    await crypto.subtle.importKey(
      "raw",
      bytes,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"]
    );

    return true;
  } catch {
    return false;
  }
}

serve(async (req: Request) => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
        "Access-Control-Allow-Headers": "Authorization, Content-Type, x-admin-token",
      },
    });
  }

  // Yalnızca POST ve GET kabul et
  if (req.method !== "POST" && req.method !== "GET") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  // ── Admin Token Doğrulama ──────────────────────────────────────────
  const adminToken = req.headers.get("x-admin-token");
  const expectedToken = Deno.env.get("ADMIN_SECRET_TOKEN");

  if (!expectedToken) {
    return new Response(
      JSON.stringify({ error: "Sunucu yapılandırması eksik: ADMIN_SECRET_TOKEN ayarlanmamış" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }

  if (!adminToken || adminToken !== expectedToken) {
    return new Response(
      JSON.stringify({ error: "Yetkisiz erişim — admin token gerekli" }),
      {
        status: 401,
        headers: {
          "Content-Type": "application/json",
          "WWW-Authenticate": "Bearer realm=\"VOYN Admin\"",
        },
      }
    );
  }

  // ── Anahtar Üretim veya Doğrulama ─────────────────────────────────
  try {
    let action = "generate";
    let keyToValidate: string | null = null;

    if (req.method === "POST") {
      try {
        const body = await req.json();
        action = body.action || "generate";
        keyToValidate = body.publicKey || null;
      } catch {
        // Boş body tamam, varsayılan: generate
      }
    }

    if (action === "validate" && keyToValidate) {
      // Doğrulama modu
      const isValid = await validateVapidKey(keyToValidate);
      return new Response(
        JSON.stringify({ valid: isValid, publicKey: keyToValidate }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    // Üretim modu
    const keys = await generateVapidKeys();

    const responseData = {
      success: true,
      keys: {
        publicKey: keys.publicKey,
        privateKey: keys.privateKey,
      },
      usage: {
        envVars: {
          VAPID_PUBLIC_KEY: keys.publicKey,
          VAPID_PRIVATE_KEY: keys.privateKey,
          VAPID_SUBJECT: "mailto:admin@voyn.app",
        },
        clientSideConfig: `const VAPID_PUBLIC_KEY = "${keys.publicKey}";`,
        supabaseSecrets: [
          `supabase secrets set VAPID_PUBLIC_KEY="${keys.publicKey}"`,
          `supabase secrets set VAPID_PRIVATE_KEY="${keys.privateKey}"`,
          `supabase secrets set VAPID_SUBJECT="mailto:admin@voyn.app"`,
        ],
      },
      warning:
        "Bu anahtarları güvenli bir yerde saklayın. Private key'i asla istemciye gönderm eyin. Bu endpoint'i üretimde devre dışı bırakın veya IP kısıtlaması uygulayın.",
      generatedAt: new Date().toISOString(),
    };

    console.log("[generate-vapid] Yeni VAPID anahtarları üretildi");

    return new Response(JSON.stringify(responseData, null, 2), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store", // Önbelleğe alma
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (err) {
    console.error("[generate-vapid] Hata:", err);
    return new Response(
      JSON.stringify({ error: String(err) }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
});
