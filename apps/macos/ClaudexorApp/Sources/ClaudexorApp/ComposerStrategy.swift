import Foundation
import ClaudexorKit

/// Agent execution strategy knob (D24): Agent mode offers these as KNOBS
/// (Single is the default), replacing the old distinct Best-of / Create /
/// Until-clean INTENTS. Plan mode has its own Council knob; Ask carries none.
enum AgentStrategy: String, CaseIterable, Identifiable, Hashable {
    case single, bestOf, untilClean, create
    var id: String { rawValue }
    var label: String {
        switch self {
        case .single: return "Single"
        case .bestOf: return "Best-of"
        case .untilClean: return "Until clean"
        case .create: return "Create"
        }
    }
    var glyph: String {
        switch self {
        case .single: return "bolt.fill"
        case .bestOf: return "flag.checkered.2.crossed"
        case .untilClean: return "arrow.triangle.2.circlepath"
        case .create: return "plus.square.on.square"
        }
    }
    var blurb: String {
        switch self {
        case .single: return "One candidate with optional model review; completed changes can be applied normally."
        case .bestOf: return "N candidates in isolated envelopes, cross-reviewed, best wins."
        case .untilClean: return "One envelope repaired until gates/review are clean."
        case .create: return "Scaffold a brand-new repo or component."
        }
    }

    /// Read-only Agent turns cannot enter a repair/convergence loop. Keep the
    /// other Agent shapes available and remove only the incompatible control.
    static func composerCases(access: AccessProfile) -> [AgentStrategy] {
        access == .readOnly ? allCases.filter { $0 != .untilClean } : allCases
    }

    /// Reconcile stored UI state when access narrows while the popover is
    /// closed. A stale Until-clean selection becomes the honest Single shape;
    /// every other strategy remains the user's selection.
    func reconciling(access: AccessProfile) -> AgentStrategy {
        access == .readOnly && self == .untilClean ? .single : self
    }
}

/// The composer's per-turn strategy selection resolved into the wire-shaped
/// facts a thread turn actually carries. PURE (no SwiftUI, no model) so the
/// mapping — Agent's Delegate/strategy and Plan's Council + member count — is
/// unit-tested without a running app (item 8: composer mode/strategy mapping).
///
/// `mode` is the effective `RunMode` `sendTurn` routes on (Best-of / Create
/// keep their historical enum cases so the pool/`n` logic there is unchanged);
/// the boolean/`n` facts ride alongside as the delegation belt (D32) and
/// Council (D31) request fields.
struct ComposerStrategyResolution: Equatable {
    var mode: RunMode
    /// Agent delegation belt (D32); only ever true on an agent-family mode.
    var delegate: Bool
    /// Plan council (D31); only ever true on `.plan`.
    var council: Bool
    /// Council membership width (2..effective cap) when `council`; nil otherwise (Best-of
    /// width stays pool-derived in `sendTurn`, never carried here).
    var councilN: Int?
    /// Agent "until clean" repair strategy.
    var untilClean: Bool
}

/// Resolve (intent, knobs) → the request-relevant strategy facts. Meaningless
/// combinations are made unrepresentable: Delegate is dropped off non-agent
/// intents, Council off non-plan, member count clamped to the daemon's effective cap.
func resolveComposerStrategy(
    intent: RunMode,
    agentStrategy: AgentStrategy,
    delegate: Bool,
    councilEnabled: Bool,
    councilMembers: Int,
    maxCouncilMembers: Int
) -> ComposerStrategyResolution {
    switch intent {
    case .plan:
        guard councilEnabled else {
            return .init(mode: .plan, delegate: false, council: false, councilN: nil, untilClean: false)
        }
        return .init(mode: .plan, delegate: false, council: true,
                     councilN: min(max(councilMembers, 2), maxCouncilMembers), untilClean: false)
    case .agent:
        switch agentStrategy {
        case .single:
            return .init(mode: .agent, delegate: delegate, council: false, councilN: nil, untilClean: false)
        case .untilClean:
            return .init(mode: .agent, delegate: delegate, council: false, councilN: nil, untilClean: true)
        case .bestOf:
            return .init(mode: .bestOfN, delegate: delegate, council: false, councilN: nil, untilClean: false)
        case .create:
            return .init(mode: .create, delegate: delegate, council: false, councilN: nil, untilClean: false)
        }
    default:
        // Ask (and any other read-only intent) carries no strategy.
        return .init(mode: intent, delegate: false, council: false, councilN: nil, untilClean: false)
    }
}

/// Pending config does not change the running daemon's admission. Only engines
/// that omit this projection keep the historical four-member composer limit.
func composerCouncilMemberLimit(_ settings: SettingsSnapshot?) -> Int {
    settings?.runtime?.concurrency?.effective.maxCouncilMembers ?? 4
}

/// The repair fields that actually survive serialization for one resolved
/// composer mode. Hidden/stale controls must pass through this owner too: a
/// Best-of or Create turn, for example, cannot accidentally look convergent to
/// an availability gate when `sendTurn` will omit its stale attempts value.
struct ComposerRepairWire: Equatable {
    var attempts: Int?
    var untilClean: Bool?
}

func composerRepairWire(
    mode: RunMode,
    access: AccessProfile,
    requestedAttempts: Int?,
    requestedUntilClean: Bool
) -> ComposerRepairWire {
    guard access != .readOnly else {
        return ComposerRepairWire(attempts: nil, untilClean: nil)
    }
    let flags = mode.strategyFlags
    let isPlainAgent = mode == .agent
    let untilClean = (isPlainAgent && requestedUntilClean) || flags.untilClean
    return ComposerRepairWire(
        attempts: isPlainAgent && !untilClean ? requestedAttempts : nil,
        untilClean: untilClean ? true : nil)
}

/// Select a server-projected Git cell from the exact access and repair fields
/// that will ride the wire. This classifies; it never decides whether Git is
/// required.
func composerRunApplicabilityShape(
    mode: RunMode,
    access: AccessProfile,
    repair: ComposerRepairWire
) -> RunApplicabilityShape {
    guard access != .readOnly else { return .readOnly }
    guard mode.apiValue == "agent" else { return .readOnly }
    return repair.untilClean == true || repair.attempts != nil ? .agentConvergence : .agentOther
}

/// Project the composer's explicit review choice. Ordinary Single keeps its
/// existing repair cap while opting out of model review. Selecting a strategy
/// that promises review, or a reviewer panel, is itself an explicit review request.
func composerReviewWire(
    mode: RunMode,
    requestedReview: Bool?,
    hasExplicitPanel: Bool,
    untilClean: Bool
) -> Bool? {
    guard mode.apiValue == "agent" else { return nil }
    if hasExplicitPanel || mode == .bestOfN || mode == .maxAttempts
        || mode == .untilClean || untilClean { return true }
    return requestedReview ?? false
}
