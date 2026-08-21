import type { ImageGenerationProvider, GenerationTrace } from "@/ai/types";
import type { AssetCategory } from "@/domain/types";
import type { BackgroundRemovalProvider } from "./providers/types";
import {
  processAssetImage,
  validateTransparentImageBytes,
  type AssetPostProcessor,
  type AssetProcessingOptions,
  type AssetProcessingResult,
} from "./postProcessor";

export const CUTOUT_INSTRUCTION = "Extract only the character. Remove the entire background. Return the character isolated on a real transparent alpha background. Preserve all line art, facial details, clothing, hair, hands and feet. Do not redraw or restyle the character. Do not render a checkerboard.";

export function createAssetProcessingPipeline(input: {
  imageProvider?: ImageGenerationProvider;
  backgroundProvider?: BackgroundRemovalProvider;
  trace?: GenerationTrace;
}): AssetPostProcessor {
  return {
    async process(data: Buffer, category: AssetCategory, options: AssetProcessingOptions = {}) {
      const inspected = await processAssetImage(data, category, { ...options, allowLocalFallback: false });
      if (inspected.processingStatus === "ready" || (category !== "character" && category !== "prop")) return inspected;

      const failures: string[] = [];
      const strategy = options.strategy ?? "auto";
      const imageProvider = input.imageProvider;
      if ((strategy === "auto" || strategy === "image-edit") && imageProvider?.capabilities.supportsImageEditing && imageProvider.editImage) {
        input.trace?.("background_removal_attempt_start", { method: "image_edit", provider: imageProvider.id });
        try {
          const edited = await imageProvider.editImage({
            instruction: CUTOUT_INSTRUCTION,
            image: { mimeType: options.sourceMimeType ?? "image/png", data, url: options.sourceUrl },
            trace: input.trace,
          });
          const validated = await validateTransparentImageBytes(edited.data, "image-edit", imageProvider.id, options);
          input.trace?.("background_removal_attempt_complete", {
            method: "image_edit",
            provider: imageProvider.id,
            status: validated.processingStatus,
          });
          if (validated.processingStatus === "ready") return validated;
          failures.push(`Image AI: ${validated.reason}`);
        } catch (error) {
          failures.push(`Image AI: ${safeError(error)}`);
          input.trace?.("background_removal_attempt_complete", { method: "image_edit", provider: imageProvider.id, status: "failed" });
        }
      }
      if (strategy === "image-edit" && !imageProvider?.editImage) failures.push("Image AI: configured provider does not support image editing");

      const backgroundProvider = input.backgroundProvider;
      if ((strategy === "auto" || strategy === "provider") && backgroundProvider) {
        input.trace?.("background_removal_attempt_start", { method: "dedicated_provider", provider: backgroundProvider.id });
        try {
          const result = await backgroundProvider.removeBackground({
            imageUrl: options.sourceUrl,
            imageBytes: data,
            mimeType: options.sourceMimeType,
            trace: input.trace,
          });
          input.trace?.("background_removal_attempt_complete", {
            method: "dedicated_provider",
            provider: backgroundProvider.id,
            status: result.success ? "ready" : "failed",
          });
          if (result.success && result.processedImage) {
            const validated = await validateTransparentImageBytes(
              result.processedImage,
              "dedicated-provider",
              result.providerMetadata.id,
              options,
            );
            if (validated.processingStatus === "ready") return validated;
            failures.push(`${backgroundProvider.name}: ${validated.reason}`);
          } else {
            failures.push(`${backgroundProvider.name}: ${result.safeError ?? result.alphaValidation.reason ?? "unusable cutout"}`);
          }
        } catch (error) {
          failures.push(`${backgroundProvider.name}: ${safeError(error)}`);
          input.trace?.("background_removal_attempt_complete", { method: "dedicated_provider", provider: backgroundProvider.id, status: "failed" });
        }
      }
      if (strategy === "provider" && !backgroundProvider) failures.push("Dedicated provider: not configured");

      if (strategy !== "auto" && strategy !== "local") return failedWithDetails(failures);
      input.trace?.("background_removal_attempt_start", { method: "local_fallback", provider: "built-in-connectivity" });
      const local = await processAssetImage(data, category, options);
      input.trace?.("background_removal_attempt_complete", { method: "local_fallback", provider: "built-in-connectivity", status: local.processingStatus });
      if (local.processingStatus === "ready") return local;
      failures.push(`Local fallback: ${local.reason}`);
      return failedWithDetails(failures);
    },
  };
}

function failedWithDetails(failures: string[]): AssetProcessingResult {
  return {
    sourceHasAlpha: false,
    hasAlpha: false,
    backgroundRemoved: false,
    processingStatus: "failed",
    reason: `Foreground extraction fallback could not determine a reliable subject mask. ${failures.join(" · ")}`,
  };
}

function safeError(error: unknown): string {
  if (error instanceof Error && "safeMessage" in error) return String((error as { safeMessage: unknown }).safeMessage);
  return error instanceof Error ? error.message : "provider failed";
}
