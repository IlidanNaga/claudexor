import Foundation

public struct TimelineEvent: Codable, Sendable, Identifiable, Equatable {
    public var id: String { "\(type)-\(ts ?? "")-\(title)-\(attemptId ?? "")" }
    public let type: String
    public let ts: String?
    public let harnessId: String?
    public let attemptId: String?
    public let title: String
    public let detail: String?
    /// Adapter-declared text category. Detail preserves the redacted text and
    /// its whitespace; title may be abbreviated. Nil for old or non-text rows.
    public let textKind: String?
    /// Only true for explicit text fragments, never complete messages.
    /// Optional so older daemon payloads retain their separate-event semantics.
    public let textDelta: Bool?
    public let severity: String?
    public let toolName: String?
    public let target: String?
    public let errorSummary: String?
    /// Unsupported per-harness knobs the route could NOT honor (INV-105),
    /// disclosed on `harness.started` (e.g. "max_turns=5 (manifest ... =false)").
    /// The row renders warning-shaped with these values, so a requested
    /// safety/behavior limit that was dropped is visible, not silent (QA-070).
    /// Optional so an older daemon that omits the key decodes to nil.
    public let ignoredSettings: [String]?
    public let rawRef: String?

    public init(type: String, ts: String?, harnessId: String?, attemptId: String?,
                title: String, detail: String?, severity: String?, toolName: String?,
                target: String?, errorSummary: String?, ignoredSettings: [String]? = nil,
                rawRef: String?, textKind: String? = nil, textDelta: Bool? = nil) {
        self.type = type
        self.ts = ts
        self.harnessId = harnessId
        self.attemptId = attemptId
        self.title = title
        self.detail = detail
        self.textKind = textKind
        self.textDelta = textDelta
        self.severity = severity
        self.toolName = toolName
        self.target = target
        self.errorSummary = errorSummary
        self.ignoredSettings = ignoredSettings
        self.rawRef = rawRef
    }
}
