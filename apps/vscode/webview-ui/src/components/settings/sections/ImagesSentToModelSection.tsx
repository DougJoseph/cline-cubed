import type { UpdateSettingsRequest } from "@shared/proto/cline/state"
import { memo, useEffect, useId, useState } from "react"
import { Input } from "@/components/ui/input"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { updateSetting } from "../utils/settingsHandlers"

/** The defaults, matching the engine's built-in image limits. */
const DEFAULTS = { total: 8, perImage: 5, perImageDecoded: 6 }

type LimitKey = keyof Pick<UpdateSettingsRequest, "imagesTotalLimitMb" | "imagesPerImageLimitMb" | "imagesPerImageDecodedLimitMb">

const LimitField = ({
	label,
	description,
	settingKey,
	stored,
}: {
	label: string
	description: string
	settingKey: LimitKey
	stored: number
}) => {
	const id = useId()
	const [text, setText] = useState(String(stored))
	const [error, setError] = useState<string>()

	useEffect(() => {
		setText(String(stored))
		setError(undefined)
	}, [stored])

	return (
		<div className="flex flex-col gap-1">
			<label className="text-sm text-foreground" htmlFor={id}>
				{label}
			</label>
			<Input
				className="w-32"
				id={id}
				inputMode="decimal"
				onChange={(event) => {
					const value = event.target.value
					setText(value)
					const parsed = Number(value.trim())
					if (value.trim() === "" || !Number.isFinite(parsed) || parsed <= 0) {
						setError("Enter a number greater than 0. Nothing was saved.")
						return
					}
					setError(undefined)
					updateSetting(settingKey, parsed)
				}}
				value={text}
			/>
			<p className="m-0 text-xs text-muted-foreground">{description}</p>
			{error && (
				<div className="text-xs text-error" role="alert">
					{error}
				</div>
			)}
		</div>
	)
}

/**
 * Cline Cubed: whether earlier images go to the model as pictures or as text descriptions, the limits
 * on images sent as pictures, and which model writes the descriptions.
 */
const ImagesSentToModelSection = () => {
	const { imagesTotalLimitMb, imagesPerImageLimitMb, imagesPerImageDecodedLimitMb, imageDescriber, earlierImages } =
		useExtensionState()
	const describerId = useId()
	const earlierImagesId = useId()

	return (
		<div className="flex flex-col gap-3 py-3" id="images-sent-to-model">
			<div className="text-sm font-medium text-foreground">Images sent to the model</div>
			<p className="m-0 text-xs text-muted-foreground">
				Every image you paste is saved with the chat on this computer, even if it is not sent to the model as a picture
				due to your settings or model limitations. Images that do not fit these limits are sent as text descriptions
				instead, keeping the newest images as pictures. Because each image stays saved, the model can ask to see it as a
				picture again. Sizes are measured as sent, about a third larger than the files.
			</p>
			<div className="flex flex-col gap-1">
				<label className="text-sm text-foreground" htmlFor={earlierImagesId}>
					Earlier images
				</label>
				<select
					className="w-full rounded-sm border border-input-border bg-input-background p-1 text-sm text-input-foreground"
					id={earlierImagesId}
					onChange={(event) => updateSetting("earlierImages", event.target.value)}
					value={earlierImages ?? "pictures"}>
					<option value="pictures">Send as pictures</option>
					<option value="descriptions">Send as descriptions</option>
				</select>
				<p className="m-0 text-xs text-muted-foreground">
					As pictures, every image in the chat goes with each message while the limits allow. A server that reuses
					unchanged images costs little for this. As descriptions, an image goes as a picture with the message it came
					with, then as a text description, which uses less context but can miss details. Either way, the image itself
					stays saved in the chat.
				</p>
			</div>
			<LimitField
				description="All the pictures sent in one request to the model together."
				label="All images in one request (MB)"
				settingKey="imagesTotalLimitMb"
				stored={imagesTotalLimitMb ?? DEFAULTS.total}
			/>
			<LimitField
				description="One picture, measured as sent."
				label="Each image, as sent (MB)"
				settingKey="imagesPerImageLimitMb"
				stored={imagesPerImageLimitMb ?? DEFAULTS.perImage}
			/>
			<LimitField
				description="One picture, measured after decoding."
				label="Each image, decoded (MB)"
				settingKey="imagesPerImageDecodedLimitMb"
				stored={imagesPerImageDecodedLimitMb ?? DEFAULTS.perImageDecoded}
			/>
			<div className="flex flex-col gap-1">
				<label className="text-sm text-foreground" htmlFor={describerId}>
					Describe images with
				</label>
				<select
					className="w-full rounded-sm border border-input-border bg-input-background p-1 text-sm text-input-foreground"
					id={describerId}
					onChange={(event) => updateSetting("imageDescriber", event.target.value)}
					value={imageDescriber ?? "imageModeFirst"}>
					<option value="imageModeFirst">Image Mode model first, then the main model</option>
					<option value="mainModelFirst">Main model first, then the Image Mode model</option>
				</select>
				<p className="m-0 text-xs text-muted-foreground">
					If the first can't see images or isn't set, the other is used. If neither can, the chat says the image can't
					be read.
				</p>
			</div>
		</div>
	)
}

export default memo(ImagesSentToModelSection)
