import ClaudexorKit

/// Selects remote managed-login transport only from the current engine
/// projection. Kept outside the action owner so the sequencing contract stays
/// independently testable without pushing that owner over the readability cap.
enum RemoteSetupLoginRouting {
    enum Decision: Equatable {
        case transport(SetupJobTransport)
        case unavailable(String)
    }

    static func decision(
        harness: SetupHarness,
        capability: HarnessSetupLoginCapability?
    ) -> Decision {
        guard let capability else {
            return .unavailable(
                "The remote engine did not provide a current managed-login capability for \(HarnessFamily(rawValue: harness.rawValue).label). Reconnect or refresh Harness Doctor before trying again.")
        }
        switch capability {
        case .legacyAbsent:
            return .transport(harness == .codex ? .daemon : .clientPty)
        case .unavailable:
            return .unavailable(
                "The remote engine reports no managed login for \(HarnessFamily(rawValue: harness.rawValue).label).")
        case .inApp:
            return .transport(.daemon)
        case .externalTerminal:
            return .transport(.clientPty)
        }
    }

    static func decision(
        harness: SetupHarness,
        in harnesses: [HarnessInfo]?
    ) -> Decision {
        decision(
            harness: harness,
            capability: harnesses?
                .first(where: { $0.family.rawValue == harness.rawValue })?.setupLogin)
    }

    /// A cold caller cannot inspect setupLogin until its current daemon
    /// projection has been loaded. Keeping the await inside this owner makes
    /// pre-connect fallback to `.legacyAbsent` structurally unavailable.
    @MainActor static func decisionAfterLoadingCurrentProjection(
        harness: SetupHarness,
        load: () async -> [HarnessInfo]?
    ) async -> Decision {
        decision(harness: harness, in: await load())
    }
}
