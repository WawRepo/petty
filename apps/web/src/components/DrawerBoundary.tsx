import { Component, type ErrorInfo, type ReactNode } from "react";
import { LedgerError } from "@petty/ledger";

/**
 * A fence round one drawer's part of a screen (PETTY-443): when drawing it fails, that part alone is
 * replaced by `fallback`; the other drawers and the rest of the app stay as they are. `resetKey` is what
 * the part is drawn from: when it changes (a reload, a restored version), drawing is tried again.
 * The log line has the error's class, a ledger code and the component stack, never content (CLAUDE.md rule 2).
 */
interface Props { resetKey: unknown; fallback: ReactNode; children: ReactNode }
interface State { failed: boolean; resetKey: unknown }
export class DrawerBoundary extends Component<Props, State> {
  override state: State = { failed: false, resetKey: this.props.resetKey };
  static getDerivedStateFromError(): Partial<State> { return { failed: true }; }
  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    return props.resetKey === state.resetKey ? null : { failed: false, resetKey: props.resetKey };
  }
  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("drawer render failed", error.name, error instanceof LedgerError ? error.code : "", info.componentStack);
  }
  override render() { return this.state.failed ? this.props.fallback : this.props.children; }
}
