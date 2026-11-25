import { convertImageBytesToPng } from "@integrations/misc/convert-image"
import { ConvertImageRequest, ConvertImageResponse } from "@shared/proto/cline/file"
import type { Controller } from ".."

/** Converts an image the webview could not decode, and reports why when it cannot. */
export async function convertImageToPng(_controller: Controller, request: ConvertImageRequest): Promise<ConvertImageResponse> {
	const result = await convertImageBytesToPng(request.name, Buffer.from(request.base64, "base64"))
	return ConvertImageResponse.create({ dataUrl: result.dataUrl ?? "", error: result.error ?? "" })
}
