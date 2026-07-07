import type { CompressionProfileName } from "../profiles.js";

export interface CompressionResponse {
  ok: boolean;
  jobId?: string;
  downloadUrl?: string;
  summary?: {
    status: "success" | "no_gain";
    inputPath: string;
    outputPath: string;
    profile: CompressionProfileName;
    originalBytes: number;
    outputBytes: number;
    reductionBytes: number;
    reductionPercent: number;
    outputSmaller: boolean;
    engine: string;
    warnings: string[];
  };
  code?: string;
  message?: string;
}

export async function compressFile(file: File, profile: CompressionProfileName): Promise<CompressionResponse> {
  const response = await fetch(`/api/compress?profile=${encodeURIComponent(profile)}`, {
    method: "POST",
    headers: {
      "content-type": "application/pdf",
      "x-filename": file.name
    },
    body: await file.arrayBuffer()
  });
  return response.json() as Promise<CompressionResponse>;
}

export function downloadUrl(path: string): string {
  return path;
}
