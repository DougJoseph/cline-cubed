import styled from "styled-components"
import { CODE_BLOCK_BG_COLOR } from "./CodeBlock"

interface PopupModalContainerProps {
	$menuPosition: number
	$arrowPosition: number
	$bottomOffset?: number
	$maxHeight?: string
	/** Cline Cubed: an outline color for a popover that must stand apart from the chat behind it. */
	$borderColor?: string
	/** Cline Cubed: how far in from the panel's left and right edges the popover sits, in px (10 unless set). */
	$sideInset?: number
}

/**
 * Shared styled container for popup modals (ModelPicker, ServersToggle, ClineRulesToggle).
 * Provides consistent positioning, styling, and arrow pointer.
 */
const PopupModalContainer = styled.div<PopupModalContainerProps>`
	position: fixed;
	left: ${(props) => props.$sideInset ?? 10}px;
	right: ${(props) => props.$sideInset ?? 10}px;
	bottom: ${(props) => `calc(100vh - ${props.$menuPosition}px + ${props.$bottomOffset ?? 6}px)`};
	display: flex;
	flex-direction: column;
	max-height: ${(props) => props.$maxHeight ?? "calc(100vh - 100px)"};
	background: ${CODE_BLOCK_BG_COLOR};
	border: 1px solid ${(props) => props.$borderColor ?? "var(--vscode-editorGroup-border)"};
	border-bottom: none;
	border-radius: 6px 6px 0 0;
	z-index: 49;
	overscroll-behavior: contain;

	&::before {
		content: "";
		position: absolute;
		bottom: 0;
		left: 0;
		right: 0;
		height: 1px;
		background: ${(props) => props.$borderColor ?? "var(--vscode-editorGroup-border)"};
		z-index: -1;
	}

	&::after {
		content: "";
		position: absolute;
		bottom: -5px;
		right: ${(props) => props.$arrowPosition - (props.$sideInset ?? 10)}px;
		height: 10px;
		width: 10px;
		transform: rotate(45deg);
		border-right: 1px solid ${(props) => props.$borderColor ?? "var(--vscode-editorGroup-border)"};
		border-bottom: 1px solid ${(props) => props.$borderColor ?? "var(--vscode-editorGroup-border)"};
		background: ${CODE_BLOCK_BG_COLOR};
		z-index: -1;
	}
`

export default PopupModalContainer
