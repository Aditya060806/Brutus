import StudioSettings from '@renderer/components/studio/StudioSettings'
import { SettingsHeader } from '../controls'

/**
 * Hosts the existing Studio settings surface.
 *
 * `StudioSettings` owns real behaviour — default agent, per-agent models,
 * parallel-work limits, health checks and worktree reclaim — and it is covered
 * by the Studio test suites. It is mounted as-is rather than rebuilt: this pass
 * is a presentation change, and rewriting a tested surface to match a border
 * radius would be a bad trade.
 */
const StudioPanel = (): React.JSX.Element => (
  <div className="flex flex-col gap-5">
    <SettingsHeader
      title="Studio"
      description="Defaults for the agent canvas — which CLI to launch, which model it runs, and how work is isolated."
    />
    <StudioSettings />
  </div>
)

export default StudioPanel
