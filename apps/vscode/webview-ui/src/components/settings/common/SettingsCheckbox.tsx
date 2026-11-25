import { VSCodeCheckbox } from "@vscode/webview-ui-toolkit/react"
import type { ComponentProps, FormEvent, KeyboardEvent } from "react"
import { useRef } from "react"

/**
 * The toolkit checkbox fires its change event when React sets `checked`, as well as on a click.
 * A redraw that lands before a save returns would otherwise save the old value over the click,
 * so only a change produced by a click or the Space key reaches `onChange`.
 */
type SettingsCheckboxProps = Omit<ComponentProps<typeof VSCodeCheckbox>, "onChange"> & {
	onChange?: (event: Event | FormEvent<HTMLElement>) => unknown
}

export const SettingsCheckbox = ({ onChange, ...props }: SettingsCheckboxProps) => {
	const fromPerson = useRef(false)
	const markGesture = () => {
		fromPerson.current = true
		// The toolkit toggles during this same event; anything later is not this gesture.
		setTimeout(() => {
			fromPerson.current = false
		}, 0)
	}

	return (
		<span
			className="contents"
			onClickCapture={markGesture}
			onKeyPressCapture={(event: KeyboardEvent) => {
				if (event.key === " ") {
					markGesture()
				}
			}}>
			<VSCodeCheckbox
				{...props}
				onChange={(event) => {
					if (!fromPerson.current) {
						return
					}
					fromPerson.current = false
					onChange?.(event)
				}}
			/>
		</span>
	)
}
