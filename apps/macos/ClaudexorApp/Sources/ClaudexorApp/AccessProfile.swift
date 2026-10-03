import Foundation

// MARK: - Access profile (per-turn write scope)

/// How much an Agent turn may touch — surfaced in the composer's Access chip
/// and sent on the turn (the engine's `access` field). Ask and Plan ignore it.
///
/// Extracted from `DomainModels.swift` so the active four-value model stays a small,
/// single-owner unit (INV-124 readability ratchet).
enum AccessProfile: String, CaseIterable, Identifiable {
    case readOnly, workspaceWrite, full, inheritNative
    var id: String { rawValue }
    /// The profiles a composer turn may pick. inherit-native remains CLI-only.
    static let composerCases: [AccessProfile] = [.readOnly, .workspaceWrite, .full]
    var satisfiesFullAccessRequirement: Bool {
        self == .full
    }
    var label: String {
        switch self {
        case .readOnly: return "Read-only"
        case .workspaceWrite: return "Workspace write"
        case .full: return "Full access"
        case .inheritNative: return "Inherit native"
        }
    }
    var glyph: String {
        switch self {
        case .readOnly: return "eye"
        case .workspaceWrite: return "square.and.pencil"
        case .full: return "lock.open"
        case .inheritNative: return "arrow.triangle.branch"
        }
    }
    /// The engine wire value for `ControlRunStartRequest.access`.
    var wire: String {
        switch self {
        case .readOnly: return "readonly"
        case .workspaceWrite: return "workspace_write"
        case .full: return "full"
        case .inheritNative: return "inherit_native"
        }
    }
    /// Lossless decode from an engine wire value (nil for an unknown value — the
    /// caller falls back to the raw string, never a silent coercion).
    init?(wire: String) {
        switch wire {
        case "readonly": self = .readOnly
        case "workspace_write": self = .workspaceWrite
        case "full": self = .full
        case "inherit_native": self = .inheritNative
        default: return nil
        }
    }
    /// Historical display remains readable without making the retired value active.
    static func humanize(_ wire: String) -> String {
        if wire == "external_sandbox_full" { return "Retired external sandbox (full)" }
        return AccessProfile(wire: wire)?.label ?? wire
    }
}

/// Composer-owned projection of a thread's recorded access wire. A retired or
/// unknown historical value is not an active profile and must remain a distinct
/// migration-required state until the server confirms an explicit active PATCH.
enum ComposerThreadAccessSelection: Equatable {
    case active(AccessProfile)
    case migrationRequired(recordedWire: String, suggested: AccessProfile)

    static func resolve(
        recordedWire: String?,
        defaultAccess: AccessProfile
    ) -> ComposerThreadAccessSelection {
        guard let recordedWire else { return .active(defaultAccess) }
        guard let active = AccessProfile(wire: recordedWire) else {
            return .migrationRequired(recordedWire: recordedWire, suggested: defaultAccess)
        }
        return .active(active)
    }

    var suggestedAccess: AccessProfile {
        switch self {
        case .active(let access): return access
        case .migrationRequired(_, let suggested): return suggested
        }
    }

    var activeAccess: AccessProfile? {
        guard case .active(let access) = self else { return nil }
        return access
    }

    var migrationBlocker: String? {
        guard case .migrationRequired = self else { return nil }
        return "Choose an active access profile for this historical thread before continuing."
    }

    /// A migration choice always persists, even when it equals the repository
    /// default. Ordinary active selections retain the existing no-op behavior.
    func action(
        selecting access: AccessProfile,
        recordedWire: String?,
        defaultAccess: AccessProfile
    ) -> ComposerThreadAccessAction {
        let currentWire = recordedWire ?? defaultAccess.wire
        let migrationRequired = activeAccess == nil
        return .init(
            access: access,
            patchWire: migrationRequired || access.wire != currentWire ? access.wire : nil,
            waitsForPersistence: migrationRequired
        )
    }
}

struct ComposerThreadAccessAction: Equatable {
    var access: AccessProfile
    var patchWire: String?
    var waitsForPersistence: Bool
}
