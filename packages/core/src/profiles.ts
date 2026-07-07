export type CompressionProfileName = "conservative" | "balanced" | "aggressive";

export interface CompressionProfile {
  name: CompressionProfileName;
  label: string;
  lossy: boolean;
  pdfSettings: "prepress" | "ebook" | "screen";
  description: string;
}

export const compressionProfiles: Record<CompressionProfileName, CompressionProfile> = {
  conservative: {
    name: "conservative",
    label: "Conservative",
    lossy: false,
    pdfSettings: "prepress",
    description: "Prioritizes fidelity and lossless structural optimization."
  },
  balanced: {
    name: "balanced",
    label: "Balanced",
    lossy: true,
    pdfSettings: "ebook",
    description: "Balances smaller files with readable image quality."
  },
  aggressive: {
    name: "aggressive",
    label: "Aggressive",
    lossy: true,
    pdfSettings: "screen",
    description: "Targets maximum reduction and may visibly reduce image fidelity."
  }
};

export function getCompressionProfile(name: string): CompressionProfile {
  const profile = compressionProfiles[name as CompressionProfileName];
  if (!profile) {
    throw new Error(`Unsupported compression profile: ${name}`);
  }
  return profile;
}
