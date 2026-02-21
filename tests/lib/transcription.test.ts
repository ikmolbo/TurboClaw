/**
 * Transcription Service Tests - TDD for Phase 5
 */

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import {
  transcribeAudio,
  type TranscriptionConfig,
  type TranscriptionResult,
} from "../../src/lib/transcription";
import path from "path";
import os from "os";
import fs from "fs";

// ============================================================================
// TEST HELPERS
// ============================================================================

const testAudioPath = path.join(os.tmpdir(), "test-audio-transcription.ogg");

const validConfig: TranscriptionConfig = {
  enabled: true,
  base_url: "https://api.openai.com/v1",
  api_key: "test-api-key-123",
  model: "whisper-1",
  retain_audio: false,
};

function makeMockResponse(body: object, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function makeMockErrorResponse(status: number, errorText: string): Response {
  return new Response(errorText, { status });
}

// ============================================================================
// CONFIG VALIDATION TESTS
// ============================================================================

describe("Config validation", () => {
  beforeEach(() => {
    fs.writeFileSync(testAudioPath, "dummy audio data");
  });

  afterEach(() => {
    if (fs.existsSync(testAudioPath)) {
      fs.unlinkSync(testAudioPath);
    }
  });

  test("missing base_url throws 'Transcription base URL not configured'", async () => {
    const config: any = {
      enabled: true,
      api_key: "test-key",
      model: "whisper-1",
      retain_audio: false,
    };

    await expect(transcribeAudio(testAudioPath, config)).rejects.toThrow(
      "Transcription base URL not configured"
    );
  });

  test("empty base_url throws 'Transcription base URL not configured'", async () => {
    const config: any = {
      enabled: true,
      base_url: "",
      api_key: "test-key",
      model: "whisper-1",
      retain_audio: false,
    };

    await expect(transcribeAudio(testAudioPath, config)).rejects.toThrow(
      "Transcription base URL not configured"
    );
  });

  test("missing api_key throws 'Transcription API key not configured'", async () => {
    const config: any = {
      enabled: true,
      base_url: "https://api.openai.com/v1",
      model: "whisper-1",
      retain_audio: false,
    };

    await expect(transcribeAudio(testAudioPath, config)).rejects.toThrow(
      "Transcription API key not configured"
    );
  });

  test("empty api_key throws 'Transcription API key not configured'", async () => {
    const config: any = {
      enabled: true,
      base_url: "https://api.openai.com/v1",
      api_key: "",
      model: "whisper-1",
      retain_audio: false,
    };

    await expect(transcribeAudio(testAudioPath, config)).rejects.toThrow(
      "Transcription API key not configured"
    );
  });

  test("missing model throws 'Transcription model not configured'", async () => {
    const config: any = {
      enabled: true,
      base_url: "https://api.openai.com/v1",
      api_key: "test-key",
      retain_audio: false,
    };

    await expect(transcribeAudio(testAudioPath, config)).rejects.toThrow(
      "Transcription model not configured"
    );
  });

  test("empty model throws 'Transcription model not configured'", async () => {
    const config: any = {
      enabled: true,
      base_url: "https://api.openai.com/v1",
      api_key: "test-key",
      model: "",
      retain_audio: false,
    };

    await expect(transcribeAudio(testAudioPath, config)).rejects.toThrow(
      "Transcription model not configured"
    );
  });

  test("missing audio file throws 'Audio file not found: <path>'", async () => {
    const missingPath = "/nonexistent/path/audio.ogg";

    await expect(transcribeAudio(missingPath, validConfig)).rejects.toThrow(
      `Audio file not found: ${missingPath}`
    );
  });

  test("validation order: base_url checked before api_key", async () => {
    const config: any = {
      enabled: true,
      // both base_url and api_key missing
      model: "whisper-1",
      retain_audio: false,
    };

    await expect(transcribeAudio(testAudioPath, config)).rejects.toThrow(
      "Transcription base URL not configured"
    );
  });

  test("validation order: api_key checked before model", async () => {
    const config: any = {
      enabled: true,
      base_url: "https://api.openai.com/v1",
      // api_key and model missing
      retain_audio: false,
    };

    await expect(transcribeAudio(testAudioPath, config)).rejects.toThrow(
      "Transcription API key not configured"
    );
  });
});

// ============================================================================
// FORMDATA PAYLOAD TESTS
// ============================================================================

describe("FormData payload and fetch call", () => {
  const originalFetch = globalThis.fetch;

  let capturedUrl: string | undefined;
  let capturedOptions: RequestInit | undefined;
  let capturedFormData: FormData | undefined;

  beforeEach(() => {
    fs.writeFileSync(testAudioPath, "dummy audio data");
    capturedUrl = undefined;
    capturedOptions = undefined;
    capturedFormData = undefined;

    globalThis.fetch = async (url: any, options: any): Promise<Response> => {
      capturedUrl = url;
      capturedOptions = options;
      capturedFormData = options?.body instanceof FormData ? options.body : undefined;
      return makeMockResponse({ text: "Hello world", duration: 2.5 });
    };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (fs.existsSync(testAudioPath)) {
      fs.unlinkSync(testAudioPath);
    }
  });

  test("fetch is called with the correct URL: ${base_url}/audio/transcriptions", async () => {
    await transcribeAudio(testAudioPath, validConfig);

    expect(capturedUrl).toBe("https://api.openai.com/v1/audio/transcriptions");
  });

  test("URL construction works with trailing slash stripped base_url", async () => {
    const config = { ...validConfig, base_url: "https://api.openai.com/v1" };
    await transcribeAudio(testAudioPath, config);

    expect(capturedUrl).toBe("https://api.openai.com/v1/audio/transcriptions");
  });

  test("URL construction works for Groq-compatible endpoint", async () => {
    const config = {
      ...validConfig,
      base_url: "https://api.groq.com/openai/v1",
    };
    await transcribeAudio(testAudioPath, config);

    expect(capturedUrl).toBe(
      "https://api.groq.com/openai/v1/audio/transcriptions"
    );
  });

  test("request method is POST", async () => {
    await transcribeAudio(testAudioPath, validConfig);

    expect(capturedOptions?.method).toBe("POST");
  });

  test("request has Authorization: Bearer <api_key> header", async () => {
    await transcribeAudio(testAudioPath, validConfig);

    const headers = capturedOptions?.headers as Record<string, string> | undefined;
    expect(headers).toBeDefined();
    expect(headers?.["Authorization"]).toBe("Bearer test-api-key-123");
  });

  test("Authorization header uses correct api_key value", async () => {
    const config = { ...validConfig, api_key: "sk-my-secret-key-xyz" };
    await transcribeAudio(testAudioPath, config);

    const headers = capturedOptions?.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer sk-my-secret-key-xyz");
  });

  test("request body is a FormData instance", async () => {
    await transcribeAudio(testAudioPath, validConfig);

    expect(capturedOptions?.body).toBeInstanceOf(FormData);
  });

  test("FormData contains 'model' field with the configured model value", async () => {
    await transcribeAudio(testAudioPath, validConfig);

    expect(capturedFormData).toBeDefined();
    expect(capturedFormData?.get("model")).toBe("whisper-1");
  });

  test("FormData 'model' field reflects different model names", async () => {
    const config = { ...validConfig, model: "mistral-voxtral-mini-2507" };
    await transcribeAudio(testAudioPath, config);

    expect(capturedFormData?.get("model")).toBe("mistral-voxtral-mini-2507");
  });

  test("FormData contains 'file' field", async () => {
    await transcribeAudio(testAudioPath, validConfig);

    expect(capturedFormData).toBeDefined();
    const fileEntry = capturedFormData?.get("file");
    expect(fileEntry).not.toBeNull();
  });

  test("FormData 'file' field is a Blob", async () => {
    await transcribeAudio(testAudioPath, validConfig);

    const fileEntry = capturedFormData?.get("file");
    expect(fileEntry).toBeInstanceOf(Blob);
  });
});

// ============================================================================
// SUCCESSFUL TRANSCRIPTION TESTS
// ============================================================================

describe("Successful transcription", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    fs.writeFileSync(testAudioPath, "dummy audio data");
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (fs.existsSync(testAudioPath)) {
      fs.unlinkSync(testAudioPath);
    }
  });

  test("returns { text, duration } from API response", async () => {
    globalThis.fetch = async () =>
      makeMockResponse({ text: "Hello world", duration: 2.5 });

    const result = await transcribeAudio(testAudioPath, {
      ...validConfig,
      retain_audio: true,
    });

    expect(result).toEqual({ text: "Hello world", duration: 2.5 });
  });

  test("returns correct text from API response", async () => {
    globalThis.fetch = async () =>
      makeMockResponse({ text: "The quick brown fox", duration: 1.0 });

    const result = await transcribeAudio(testAudioPath, {
      ...validConfig,
      retain_audio: true,
    });

    expect(result.text).toBe("The quick brown fox");
  });

  test("returns correct duration from API response", async () => {
    globalThis.fetch = async () =>
      makeMockResponse({ text: "Something", duration: 5.25 });

    const result = await transcribeAudio(testAudioPath, {
      ...validConfig,
      retain_audio: true,
    });

    expect(result.duration).toBe(5.25);
  });

  test("returns empty string for text when API returns no text field", async () => {
    globalThis.fetch = async () =>
      makeMockResponse({ duration: 1.0 });

    const result = await transcribeAudio(testAudioPath, {
      ...validConfig,
      retain_audio: true,
    });

    expect(result.text).toBe("");
  });

  test("duration is undefined when API response has no duration field", async () => {
    globalThis.fetch = async () =>
      makeMockResponse({ text: "Just text" });

    const result = await transcribeAudio(testAudioPath, {
      ...validConfig,
      retain_audio: true,
    });

    expect(result.duration).toBeUndefined();
  });

  test("result matches TranscriptionResult shape", async () => {
    globalThis.fetch = async () =>
      makeMockResponse({ text: "Hello world", duration: 2.5 });

    const result: TranscriptionResult = await transcribeAudio(testAudioPath, {
      ...validConfig,
      retain_audio: true,
    });

    expect(typeof result.text).toBe("string");
  });
});

// ============================================================================
// AUDIO FILE CLEANUP TESTS
// ============================================================================

describe("Audio file cleanup", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    fs.writeFileSync(testAudioPath, "dummy audio data");
    globalThis.fetch = async () =>
      makeMockResponse({ text: "Hello world", duration: 2.5 });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (fs.existsSync(testAudioPath)) {
      fs.unlinkSync(testAudioPath);
    }
  });

  test("file is deleted after successful transcription when retain_audio is false", async () => {
    expect(fs.existsSync(testAudioPath)).toBe(true);

    await transcribeAudio(testAudioPath, { ...validConfig, retain_audio: false });

    expect(fs.existsSync(testAudioPath)).toBe(false);
  });

  test("file is NOT deleted after successful transcription when retain_audio is true", async () => {
    expect(fs.existsSync(testAudioPath)).toBe(true);

    await transcribeAudio(testAudioPath, { ...validConfig, retain_audio: true });

    expect(fs.existsSync(testAudioPath)).toBe(true);
  });

  test("file is deleted regardless of transcription text content when retain_audio is false", async () => {
    globalThis.fetch = async () =>
      makeMockResponse({ text: "", duration: 0 });

    await transcribeAudio(testAudioPath, { ...validConfig, retain_audio: false });

    expect(fs.existsSync(testAudioPath)).toBe(false);
  });

  test("function still returns result when retain_audio is false and file is deleted", async () => {
    const result = await transcribeAudio(testAudioPath, {
      ...validConfig,
      retain_audio: false,
    });

    expect(result.text).toBe("Hello world");
    expect(result.duration).toBe(2.5);
  });
});

// ============================================================================
// HTTP ERROR HANDLING TESTS
// ============================================================================

describe("HTTP error handling", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    fs.writeFileSync(testAudioPath, "dummy audio data");
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (fs.existsSync(testAudioPath)) {
      fs.unlinkSync(testAudioPath);
    }
  });

  test("401 Unauthorized response throws error containing '401'", async () => {
    globalThis.fetch = async () =>
      makeMockErrorResponse(401, "Unauthorized");

    await expect(
      transcribeAudio(testAudioPath, { ...validConfig, retain_audio: true })
    ).rejects.toThrow("401");
  });

  test("500 Internal Server Error response throws an error", async () => {
    globalThis.fetch = async () =>
      makeMockErrorResponse(500, "Internal Server Error");

    await expect(
      transcribeAudio(testAudioPath, { ...validConfig, retain_audio: true })
    ).rejects.toThrow();
  });

  test("403 Forbidden response throws error containing '403'", async () => {
    globalThis.fetch = async () =>
      makeMockErrorResponse(403, "Forbidden");

    await expect(
      transcribeAudio(testAudioPath, { ...validConfig, retain_audio: true })
    ).rejects.toThrow("403");
  });

  test("429 Too Many Requests response throws an error", async () => {
    globalThis.fetch = async () =>
      makeMockErrorResponse(429, "Rate limit exceeded");

    await expect(
      transcribeAudio(testAudioPath, { ...validConfig, retain_audio: true })
    ).rejects.toThrow();
  });

  test("error message for non-OK response includes the HTTP status code", async () => {
    globalThis.fetch = async () =>
      makeMockErrorResponse(401, "Invalid token");

    let thrownError: Error | undefined;
    try {
      await transcribeAudio(testAudioPath, { ...validConfig, retain_audio: true });
    } catch (e) {
      thrownError = e as Error;
    }

    expect(thrownError).toBeDefined();
    expect(thrownError?.message).toContain("401");
  });

  test("error message for 500 response includes the HTTP status code", async () => {
    globalThis.fetch = async () =>
      makeMockErrorResponse(500, "Server exploded");

    let thrownError: Error | undefined;
    try {
      await transcribeAudio(testAudioPath, { ...validConfig, retain_audio: true });
    } catch (e) {
      thrownError = e as Error;
    }

    expect(thrownError?.message).toContain("500");
  });

  test("file is NOT deleted when transcription fails due to HTTP error", async () => {
    globalThis.fetch = async () =>
      makeMockErrorResponse(500, "Server Error");

    await expect(
      transcribeAudio(testAudioPath, { ...validConfig, retain_audio: false })
    ).rejects.toThrow();

    // File should still exist because the transcription failed
    expect(fs.existsSync(testAudioPath)).toBe(true);
  });

  test("network error (fetch throws) propagates as rejection", async () => {
    globalThis.fetch = async () => {
      throw new Error("Network unreachable");
    };

    await expect(
      transcribeAudio(testAudioPath, { ...validConfig, retain_audio: true })
    ).rejects.toThrow("Network unreachable");
  });
});
