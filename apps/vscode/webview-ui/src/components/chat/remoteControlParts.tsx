import { Laptop, Smartphone, Tablet } from "lucide-react"
import React from "react"

/**
 * The colors a simulated LED takes in the Remote Control popover:
 * on (glowing green), off (dim red), busy (amber, pulsing), fault (glowing red), idle (grey),
 * and unseen (a dim grey, for a paired device not heard from lately).
 */
export type LedColor = "on" | "off" | "busy" | "fault" | "idle" | "unseen"

const LED_CLASS: Record<LedColor, string> = {
	on: "bg-[var(--vscode-charts-green)] shadow-[0_0_6px_var(--vscode-charts-green)]",
	off: "bg-[var(--vscode-charts-red)] opacity-40",
	busy: "bg-[var(--vscode-charts-yellow)] shadow-[0_0_6px_var(--vscode-charts-yellow)] animate-pulse",
	fault: "bg-[var(--vscode-charts-red)] shadow-[0_0_6px_var(--vscode-charts-red)]",
	idle: "bg-[var(--vscode-disabledForeground)] opacity-60",
	unseen: "bg-[var(--vscode-disabledForeground)] opacity-40",
}

export const Led: React.FC<{ color: LedColor; testId?: string; className?: string }> = ({ color, testId, className }) => (
	<span
		aria-hidden="true"
		className={`inline-block h-2 w-2 shrink-0 rounded-full ${LED_CLASS[color]} ${className ?? ""}`}
		data-led={color}
		data-testid={testId}
	/>
)

/** A paired device is shown as connected when the relay heard from it within this many seconds. */
export const DEVICE_CONNECTED_WITHIN_SECONDS = 120

export type DeviceKind = "phone" | "tablet" | "computer"

/** Whether a device's browser string names a phone, a tablet, or a computer. An iPad that reports itself as a Mac reads as a computer. */
export function deviceKind(name: string): DeviceKind {
	if (/iPad|Tablet/i.test(name) || (/Android/i.test(name) && !/Mobile/i.test(name))) {
		return "tablet"
	}
	if (/iPhone|iPod|Android|Mobile/i.test(name)) {
		return "phone"
	}
	return "computer"
}

/** A short name for a device tile, read from its browser string; a name that is not a browser string is kept as it is. */
export function deviceShortName(name: string): string {
	if (!name) {
		return "Device"
	}
	const platforms: Array<[RegExp, string]> = [
		[/iPhone/i, "iPhone"],
		[/iPad/i, "iPad"],
		[/iPod/i, "iPod"],
		[/Android/i, "Android"],
		[/Macintosh|Mac OS X/i, "Mac"],
		[/Windows/i, "Windows"],
		[/CrOS/i, "Chromebook"],
		[/Linux/i, "Linux"],
	]
	if (!/Mozilla\//.test(name)) {
		return name
	}
	return platforms.find(([pattern]) => pattern.test(name))?.[1] ?? "Browser"
}

/** The browser a device's browser string names, for its details. */
export function deviceBrowser(name: string): string {
	const browsers: Array<[RegExp, string]> = [
		[/Edg\//, "Edge"],
		[/OPR\//, "Opera"],
		[/Firefox\/|FxiOS\//, "Firefox"],
		[/Chrome\/|CriOS\//, "Chrome"],
		[/Safari\//, "Safari"],
	]
	return browsers.find(([pattern]) => pattern.test(name))?.[1] ?? ""
}

export const DeviceIcon: React.FC<{ name: string; size?: number }> = ({ name, size = 22 }) => {
	const kind = deviceKind(name)
	return kind === "phone" ? <Smartphone size={size} /> : kind === "tablet" ? <Tablet size={size} /> : <Laptop size={size} />
}

/** Whether the relay heard from the device recently enough to call it connected. */
export function deviceSeenRecently(lastSeenAt: number, nowMs = Date.now()): boolean {
	return lastSeenAt > 0 && nowMs / 1000 - lastSeenAt <= DEVICE_CONNECTED_WITHIN_SECONDS
}

/** A date and time in the viewer's own zone, from seconds since the epoch. */
export function formatSeconds(seconds: number): string {
	return seconds > 0 ? new Date(seconds * 1000).toLocaleString() : "unknown"
}
