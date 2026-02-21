/**
 * Audio Transcription Service
 * Supports any OpenAI-compatible transcription API
 * (OpenAI Whisper, Mistral Voxtral, Groq Whisper, etc.)
 */

import { createLogger } from "./logger";
import fs from "fs";

const logger = createLogger("transcription");

// ============================================================================
// TYPES
// ============================================================================

export interface TranscriptionConfig {
  enabled: boolean;
  base_url: string;
  api_key: string;
  model: string;
  retain_audio: boolean;
}

export interface TranscriptionResult {
  text: string;
  duration?: number;
}

// ============================================================================
// TRANSCRIPTION FUNCTIONS
// ============================================================================

/**
 * Transcribe audio file using OpenAI-compatible API
 * Works with: OpenAI, Mistral, Groq, and other compatible providers
 */
export async function transcribeAudio(
  audioPath: string,
  config: TranscriptionConfig
): Promise<TranscriptionResult> {
  // Validate config
  if (!config.base_url) {
    throw new Error("Transcription base URL not configured");
  }

  if (!config.api_key) {
    throw new Error("Transcription API key not configured");
  }

  if (!config.model) {
    throw new Error("Transcription model not configured");
  }

  // Check if file exists
  if (!fs.existsSync(audioPath)) {
    throw new Error(`Audio file not found: ${audioPath}`);
  }

  logger.info("Transcribing audio", {
    base_url: config.base_url,
    model: config.model,
    path: audioPath,
  });

  try {
    const url = `${config.base_url}/audio/transcriptions`;

    // Read audio file
    const audioFile = Bun.file(audioPath);
    const audioBuffer = await audioFile.arrayBuffer();

    // Create form data
    const formData = new FormData();
    formData.append("file", new Blob([audioBuffer]), audioPath);
    formData.append("model", config.model);

    // Make request
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.api_key}`,
      },
      body: formData,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Transcription failed: ${response.status} ${errorText}`
      );
    }

    const result = await response.json();

    const transcriptionResult: TranscriptionResult = {
      text: result.text || "",
      duration: result.duration,
    };

    logger.info("Transcription successful", {
      length: transcriptionResult.text.length,
    });

    // Delete audio file if not retaining
    if (!config.retain_audio) {
      try {
        fs.unlinkSync(audioPath);
        logger.debug("Deleted audio file", { path: audioPath });
      } catch (error) {
        logger.warn("Failed to delete audio file", { path: audioPath, error });
      }
    }

    return transcriptionResult;
  } catch (error) {
    logger.error("Transcription failed", error);
    throw error;
  }
}
