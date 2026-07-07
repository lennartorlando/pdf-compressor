export type CompressionProfileName = "conservative" | "balanced" | "aggressive";

export const webCompressionProfiles: Array<{
  name: CompressionProfileName;
  label: string;
  description: string;
}> = [
  {
    name: "conservative",
    label: "Conservative",
    description: "Prioritizes fidelity and lossless structural optimization."
  },
  {
    name: "balanced",
    label: "Balanced",
    description: "Balances smaller files with readable image quality."
  },
  {
    name: "aggressive",
    label: "Aggressive",
    description: "Targets maximum reduction and may visibly reduce image fidelity."
  }
];
