"use client";

import { Component, type ErrorInfo, type ReactNode } from "react";
import { Factory } from "lucide-react";

export class FactoryErrorBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Animated factory could not start", error, info.componentStack);
  }

  render() {
    if (this.state.failed) {
      return (
        <div className="factory-fallback" role="img" aria-label="Garment factory illustration">
          <Factory aria-hidden="true" />
          <strong>SafetyProof garment factory</strong>
          <span>The interactive illustration is unavailable; all page actions remain usable.</span>
        </div>
      );
    }
    return this.props.children;
  }
}
