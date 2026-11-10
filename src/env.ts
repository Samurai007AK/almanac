// Imported first by every entry point, so keys are in place before any module reads them.
try {
  process.loadEnvFile();
} catch {
  // no .env yet; the UI tells the user what's missing
}

export const missingKeys = () => {
  const missing: string[] = [];
  if (!process.env.LLM_API_KEY && !process.env.OPENROUTER_API_KEY) missing.push("LLM_API_KEY");
  if (!process.env.TAVILY_API_KEY) missing.push("TAVILY_API_KEY");
  return missing;
};
