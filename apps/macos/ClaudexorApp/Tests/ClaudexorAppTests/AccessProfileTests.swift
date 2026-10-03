import AppKit
import Foundation
import Testing
@testable import ClaudexorApp

/// The four active values round-trip, while retired records remain displayable.
/// composer offers exactly three, and every glyph the UI renders is a REAL SF
/// Symbol (guards the removed "<glyph>.slash" synthesis regression).
@Suite struct AccessProfileTests {
    @Test func roundTripsAllActiveWireValues() {
        for profile in AccessProfile.allCases {
            #expect(AccessProfile(wire: profile.wire) == profile)
        }
        #expect(AccessProfile(wire: "inherit_native") == .inheritNative)
        #expect(AccessProfile(wire: "external_sandbox_full") == nil)
        #expect(AccessProfile.humanize("external_sandbox_full") == "Retired external sandbox (full)")
    }

    @Test func unknownWireDecodesNilAndHumanizesVerbatim() {
        #expect(AccessProfile(wire: "made_up") == nil)
        // Unknown values pass through — never silently coerced to Full/Read-only.
        #expect(AccessProfile.humanize("made_up") == "made_up")
        #expect(AccessProfile.humanize("full") == "Full access")
        #expect(AccessProfile.humanize("workspace_write") == "Workspace write")
    }

    @Test func composerOffersExactlyReadonlyWorkspaceFull() {
        #expect(AccessProfile.composerCases == [.readOnly, .workspaceWrite, .full])
        #expect(!AccessProfile.composerCases.contains(.inheritNative))
    }

    @Test func retiredStickyAccessRemainsMigrationRequiredInsteadOfBecomingDefault() {
        let selection = ComposerThreadAccessSelection.resolve(
            recordedWire: "external_sandbox_full",
            defaultAccess: .workspaceWrite
        )

        #expect(selection.activeAccess == nil)
        #expect(selection.suggestedAccess == .workspaceWrite)
        #expect(selection.migrationBlocker != nil)
        let action = selection.action(
            selecting: .workspaceWrite,
            recordedWire: "external_sandbox_full",
            defaultAccess: .workspaceWrite
        )
        #expect(action.patchWire == "workspace_write")
        #expect(action.waitsForPersistence)
    }

    @Test func activeDefaultSelectionDoesNotCreateARedundantPatch() {
        let selection = ComposerThreadAccessSelection.resolve(
            recordedWire: nil,
            defaultAccess: .workspaceWrite
        )
        let action = selection.action(
            selecting: .workspaceWrite,
            recordedWire: nil,
            defaultAccess: .workspaceWrite
        )

        #expect(selection.activeAccess == .workspaceWrite)
        #expect(action.patchWire == nil)
        #expect(!action.waitsForPersistence)
    }

    @Test func migrationStateBlocksOrdinarySendAndHasNoPlanImplementationAccess() throws {
        let selection = ComposerThreadAccessSelection.resolve(
            recordedWire: "external_sandbox_full",
            defaultAccess: .workspaceWrite
        )
        let blocker = try #require(selection.migrationBlocker)
        let availability = ComposerSendAvailability.resolve(
            message: "Continue",
            blockers: [.access(blocker)]
        )

        #expect(!availability.enabled)
        #expect(availability.disabledReason == blocker)
        #expect(selection.activeAccess == nil)
    }

    @Test func onlyFullSatisfiesHarnessFullAccess() {
        #expect(AccessProfile.full.satisfiesFullAccessRequirement)
        #expect(!AccessProfile.workspaceWrite.satisfiesFullAccessRequirement)
        #expect(!AccessProfile.inheritNative.satisfiesFullAccessRequirement)
    }

    @Test func harnessAndAccessGlyphsAreValidSFSymbols() {
        var names = AccessProfile.allCases.map(\.glyph)
        // Vendor iconography now lives in HarnessIcon; its ONE generic fallback
        // must still resolve as a real SF Symbol.
        names.append(HarnessIconCatalog.genericSymbol)
        for name in names {
            #expect(
                NSImage(systemSymbolName: name, accessibilityDescription: nil) != nil,
                "SF Symbol '\(name)' does not resolve on this deployment target")
        }
    }
}
