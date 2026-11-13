import type { EstopBannerView } from "../../logic/pilot";

interface Props {
  /** from logic/pilot.ts estopBanner(); null hides the banner */
  view: EstopBannerView | null;
  controlOpen: boolean;
  onReset: () => void;
  onRetry: () => void;
  onDismiss: () => void;
}

/** Emergency-stop band. Which state to show is decided in logic/pilot.ts; it never says the motors are cut. */
export function EstopBanner({ view, controlOpen, onReset, onRetry, onDismiss }: Props) {
  if (!view) return null;
  const failed = view.kind === "unsent" || view.kind === "not_confirmed" || view.kind === "unknown" || view.kind === "active_not_delivered";

  return (
    <div className={`estop-banner${failed ? " estop-banner-unsent" : ""}`} role="alert" data-estop-state={view.kind}>
      <div className="container estop-banner-inner">
        <strong className="estop-banner-title">{view.headline}</strong>
        <span className="estop-banner-detail">{view.detail}</span>
        <div className="row estop-banner-actions">
          {view.retry && (
            <button type="button" className="btn btn-lg estop-banner-retry" onClick={onRetry}>
              Send emergency stop again
            </button>
          )}
          {view.reset && (
            <button type="button" className="btn btn-lg" onClick={onReset} disabled={!controlOpen}>
              Reset emergency stop
            </button>
          )}
          {view.reset && !controlOpen && <span className="estop-banner-note">Reset needs the control link.</span>}
          {view.dismiss && (
            <button type="button" className="btn btn-lg" onClick={onDismiss}>
              Dismiss
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
