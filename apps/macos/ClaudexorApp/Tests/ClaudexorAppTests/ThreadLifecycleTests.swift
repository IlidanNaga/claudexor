import Foundation
import Testing
import ClaudexorKit
@testable import ClaudexorApp

/// The sidebar trash lifecycle (owner decision E1): "Delete" moves a thread to
/// Trash with one click, "Restore" brings it back, and "Delete Now…" purges it
/// after a confirmation. Each command is ONE server call plus a list re-read.
@Suite(.serialized)
struct ThreadLifecycleTests {
    // MARK: Section membership

    @Test func sectionsSplitActiveArchivedAndTrashAndNeverShowPurged() throws {
        let states = ["active", "closed", "trashed", "purged", "active"]
        let rows = try states.enumerated().map { index, state in
            LocatedThread(
                locationID: .local, thread: try lifecycleThread(id: "th-\(index)", state: state))
        }
        let sections = ThreadSidebarSections(rows)
        #expect(sections.active.map(\.thread.id) == ["th-0", "th-4"])
        #expect(sections.archived.map(\.thread.id) == ["th-1"])
        #expect(sections.trash.map(\.thread.id) == ["th-2"])
    }

    @Test func aThreadWithoutALifecycleStateStaysActive() throws {
        let legacy = try JSONDecoder().decode(ThreadSummary.self, from: Data(
            lifecycleJSON(id: "th-legacy", state: "active")
                .replacingOccurrences(of: #""state":"active""#, with: #""state":null"#).utf8))
        let sections = ThreadSidebarSections([LocatedThread(locationID: .local, thread: legacy)])
        #expect(sections.active.map(\.thread.id) == ["th-legacy"])
        #expect(sections.archived.isEmpty && sections.trash.isEmpty)
    }

    // MARK: Honest "Delete Now…" text

    @Test func deleteNowTextBranchesOnWorkspaceModeAndNeverPromisesErasure() {
        let direct = ThreadLifecycleCopy.deleteNowMessage(workspaceMode: "in_place")
        let isolated = ThreadLifecycleCopy.deleteNowMessage(workspaceMode: "isolated")
        for text in [direct, isolated] {
            #expect(text.hasPrefix("Project files are not touched."))
            // Codex config-dir logins and Antigravity keep sessions in the
            // account's own directory, which purge never deletes.
            #expect(text.contains("Saved sessions may remain in the agents' own storage."))
            #expect(!text.contains("sessions of this thread's Ask and Plan turns are deleted"))
            #expect(text.contains("Its messages stay in the local engine journal"))
            #expect(text.hasSuffix("This cannot be undone."))
            #expect(!text.contains("removes the conversation"))
        }
        #expect(!direct.contains("working copy"))
        #expect(isolated.contains(
            "The thread's separate working copy is deleted, including changes that were never applied to the project."))
        // No mode on the wire (a legacy row) makes no working-copy claim.
        #expect(ThreadLifecycleCopy.deleteNowMessage(workspaceMode: nil) == direct)
    }

    @Test func aFailedDeleteNowPromisesTrashOnlyWhileTheListStillHasItThere() {
        let reason = "Cannot reach the engine — is the daemon running?"
        let texts = [DeleteNowFailure.inTrash, .gone, .elsewhere, .unconfirmed].map {
            ($0, ThreadLifecycleCopy.deleteNowFailure($0, reason: reason))
        }
        for (outcome, text) in texts {
            #expect(text.hasSuffix(reason))
            #expect(text.contains("stays in Trash") == (outcome == .inTrash))
        }
    }

    @Test func trashCaptionStatesHowLongRestoreWorks() {
        let now = Date(timeIntervalSince1970: 1_790_000_000)
        #expect(ThreadLifecycleCopy.trashCaption(
            place: "repo", purgeAfter: "2030-01-15T12:00:00.000Z", now: now)
            .hasPrefix("repo · restorable until "))
        #expect(ThreadLifecycleCopy.trashCaption(
            place: "repo", purgeAfter: "2020-01-15T12:00:00Z", now: now)
            .hasPrefix("repo · restore period ended "))
        #expect(ThreadLifecycleCopy.trashCaption(place: "repo", purgeAfter: nil, now: now)
            == "repo · in Trash")
    }

    // MARK: Commands

    @MainActor
    @Test func deleteMovesTheThreadToTrashAndLeavesItsConversation() async throws {
        defer { LifecycleStubURLProtocol.handler = nil }
        let server = LifecycleServer(states: ["th-1": "active"])
        let model = lifecycleModel(server)
        let thread = try lifecycleThread(id: "th-1", state: "active")
        model.threads = [thread]
        model.selectedThreadId = "th-1"
        model.selectedThreadDetail = ThreadDetailResponse(thread: thread, sessions: [], turns: [])

        await model.trashThread(locationID: .local, id: "th-1")

        #expect(server.posts == ["POST /v2/threads/th-1/trash"])
        #expect(server.recorded.contains("GET /v2/threads"))
        // A trashed thread takes no turns: the conversation pane becomes a draft.
        #expect(model.selectedThreadId == nil)
        let sections = ThreadSidebarSections(model.locatedThreads)
        #expect(sections.active.isEmpty)
        #expect(sections.trash.map(\.thread.id) == ["th-1"])
    }

    @MainActor
    @Test func deleteAndDeleteNowWaitWhileATurnRunsThenReachTheEngine() async throws {
        defer { LifecycleStubURLProtocol.handler = nil }
        let server = LifecycleServer(states: ["th-1": "active", "th-2": "trashed"])
        let model = lifecycleModel(server)
        model.threads = [
            try lifecycleThread(id: "th-1", state: "active", headRunId: "run-1"),
            try lifecycleThread(id: "th-2", state: "trashed", headRunId: "run-2"),
        ]
        model.liveTasks = [runningTask("run-1"), runningTask("run-2")]

        await model.trashThread(locationID: .local, id: "th-1")
        #expect(model.threadStatus == ThreadLifecycleCopy.deleteBusyReason)
        await model.deleteThreadNow(locationID: .local, id: "th-2")
        #expect(model.threadStatus == ThreadLifecycleCopy.deleteNowBusyReason)
        #expect(server.recorded.isEmpty)

        // Once the turns finished, the same commands reach the engine.
        model.liveTasks = []
        await model.deleteThreadNow(locationID: .local, id: "th-2")
        await model.trashThread(locationID: .local, id: "th-1")
        #expect(server.posts == ["POST /v2/threads/th-2/purge", "POST /v2/threads/th-1/trash"])
    }

    @MainActor
    @Test func deleteNowPurgesOnlyThatThreadAndItLeavesTheList() async throws {
        defer { LifecycleStubURLProtocol.handler = nil }
        let server = LifecycleServer(states: ["th-1": "trashed", "th-2": "active"])
        let model = lifecycleModel(server)
        model.threads = [
            try lifecycleThread(id: "th-1", state: "trashed"),
            try lifecycleThread(id: "th-2", state: "active"),
        ]

        await model.deleteThreadNow(locationID: .local, id: "th-1")

        #expect(server.posts == ["POST /v2/threads/th-1/purge"])
        #expect(model.threads.map(\.id) == ["th-2"])
        #expect(model.threadStatus == nil)
    }

    @MainActor
    @Test func aRefusedDeleteNowLeavesTheThreadInTrashAndRestoreBringsItBack() async throws {
        defer { LifecycleStubURLProtocol.handler = nil }
        let server = LifecycleServer(states: ["th-1": "trashed"], purge: .refuse)
        let model = lifecycleModel(server)
        model.threads = [try lifecycleThread(id: "th-1", state: "trashed")]

        await model.deleteThreadNow(locationID: .local, id: "th-1")

        // No hidden trash: the engine's refusal is shown and the row stays in Trash.
        #expect(model.threadStatus?.contains("stays in Trash") == true)
        #expect(model.threadStatus?.contains("thread_busy") == true)
        #expect(ThreadSidebarSections(model.locatedThreads).trash.map(\.thread.id) == ["th-1"])

        await model.restoreThread(locationID: .local, id: "th-1")

        #expect(server.posts == ["POST /v2/threads/th-1/purge", "POST /v2/threads/th-1/restore"])
        #expect(ThreadSidebarSections(model.locatedThreads).active.map(\.thread.id) == ["th-1"])
        // The refused purge's banner does not outlive the successful Restore.
        #expect(model.threadStatus == nil)
    }

    @MainActor
    @Test func aLostPurgeAnswerSaysTheThreadWasDeletedAndPromisesNoTrash() async throws {
        defer { LifecycleStubURLProtocol.handler = nil }
        // The engine journals the purge, then its answer is lost on the way back.
        let server = LifecycleServer(states: ["th-1": "trashed"], purge: .applyThenDropAnswer)
        let model = lifecycleModel(server)
        model.threads = [try lifecycleThread(id: "th-1", state: "trashed")]

        await model.deleteThreadNow(locationID: .local, id: "th-1")

        #expect(server.posts == ["POST /v2/threads/th-1/purge"])
        #expect(server.recorded.last == "GET /v2/threads")
        #expect(ThreadSidebarSections(model.locatedThreads).trash.isEmpty)
        let status = try #require(model.threadStatus)
        #expect(status.hasPrefix("The thread was deleted"))
        #expect(!status.contains("Trash"))
    }

    @MainActor
    @Test func anUnreadableListAfterAFailedPurgeConfirmsNothingUntilALaterListShowsTheThreadGone() async throws {
        defer { LifecycleStubURLProtocol.handler = nil }
        // The purge request never reaches the engine, and the list cannot be read either.
        let server = LifecycleServer(states: ["th-1": "trashed"], purge: .dropBeforeApply)
        server.listUnreachable = true
        let model = lifecycleModel(server)
        model.threads = [try lifecycleThread(id: "th-1", state: "trashed")]

        await model.deleteThreadNow(locationID: .local, id: "th-1")

        let unconfirmed = try #require(model.threadStatus)
        #expect(unconfirmed.hasPrefix("Could not confirm whether the thread was deleted"))
        #expect(!unconfirmed.contains("stays in Trash"))
        // A later list that still has the thread in Trash keeps the banner...
        server.listUnreachable = false
        #expect(await model.refreshThreads())
        #expect(ThreadSidebarSections(model.locatedThreads).trash.map(\.thread.id) == ["th-1"])
        #expect(model.threadStatus == unconfirmed)
        // ...and a later list without the thread retires it.
        server.setState("th-1", "purged")
        #expect(await model.refreshThreads())
        #expect(model.threadStatus == nil)
    }
}

// MARK: - Fixtures

private func lifecycleJSON(
    id: String,
    state: String,
    workspaceMode: String = "in_place",
    headRunId: String? = nil
) -> String {
    let head = headRunId.map { "\"\($0)\"" } ?? "null"
    let purgeAfter = state == "trashed" ? "\"2030-01-01T00:00:00.000Z\"" : "null"
    return #"{"id":"\#(id)","title":"Thread \#(id)","repoRoot":"/tmp/project","mode":"agent","workspaceMode":"\#(workspaceMode)","authPreference":"auto","primaryHarness":null,"eligibleHarnesses":[],"state":"\#(state)","trashedAt":null,"purgeAfter":\#(purgeAfter),"runIds":[],"headRunId":\#(head),"needsHuman":false,"createdAt":"2026-10-01T00:00:00Z","updatedAt":"2026-10-01T00:00:00Z"}"#
}

private func lifecycleThread(
    id: String,
    state: String,
    headRunId: String? = nil
) throws -> ThreadSummary {
    try JSONDecoder().decode(
        ThreadSummary.self,
        from: Data(lifecycleJSON(id: id, state: state, headRunId: headRunId).utf8))
}

private func runningTask(_ id: String) -> TaskRun {
    TaskRun(
        id: id, title: "Run", prompt: "", mode: .agent, phase: .running,
        project: "Project", harnesses: [], n: 1,
        createdAt: .now, updatedAt: .now,
        spendUsd: 0, capUsd: 0, spendKnown: false, capKnown: false,
        routeProof: .unverified, attentionNote: nil, plan: [], activity: [],
        candidates: [], findings: [], diff: []
    )
}

@MainActor
private func lifecycleModel(_ server: LifecycleServer) -> AppModel {
    LifecycleStubURLProtocol.handler = { server.handle($0) }
    let config = URLSessionConfiguration.ephemeral
    config.protocolClasses = [LifecycleStubURLProtocol.self]
    let client = GatewayClient(
        baseURL: URL(string: "http://127.0.0.1:1234")!, token: "test",
        session: URLSession(configuration: config))
    let model = AppModel(client: client, requestNotificationAuthorization: false)
    model.health = .connected
    // These tests are about local threads; drop any remote rows the model
    // loaded from this machine's persisted remote cache (memory only).
    model.remoteThreadCache = []
    return model
}

/// How the tiny engine answers a purge request.
private enum PurgeBehavior {
    case apply                // 200 with the purged thread
    case refuse               // 409 thread_busy; nothing changes
    case applyThenDropAnswer  // the engine purges, but its answer never arrives
    case dropBeforeApply      // the request never reaches the engine
}

/// A tiny in-memory engine for the lifecycle routes and the thread list.
/// `handle` returns nil when the connection drops instead of answering.
private final class LifecycleServer: @unchecked Sendable {
    private let lock = NSLock()
    private var states: [String: String]
    private var calls: [String] = []
    private let purge: PurgeBehavior
    private var listDown = false

    init(states: [String: String], purge: PurgeBehavior = .apply) {
        self.states = states
        self.purge = purge
    }

    var recorded: [String] { lock.withLock { calls } }
    var posts: [String] { recorded.filter { $0.hasPrefix("POST ") } }
    /// While true, `GET /v2/threads` drops the connection.
    var listUnreachable: Bool {
        get { lock.withLock { listDown } }
        set { lock.withLock { listDown = newValue } }
    }

    /// Another client (or the engine itself) changes a thread's state.
    func setState(_ id: String, _ state: String) { lock.withLock { states[id] = state } }

    func handle(_ request: URLRequest) -> (HTTPURLResponse, Data)? {
        lock.withLock {
            let path = request.url?.path ?? ""
            let method = request.httpMethod ?? "GET"
            calls.append("\(method) \(path)")
            if method == "GET", path == "/v2/threads" {
                if listDown { return nil }
                let rows = states.keys.sorted()
                    .filter { states[$0] != "purged" }
                    .map { lifecycleJSON(id: $0, state: states[$0] ?? "active") }
                return reply(request, 200, #"{"threads":[\#(rows.joined(separator: ","))],"problems":[]}"#)
            }
            let parts = path.split(separator: "/").map(String.init)
            guard method == "POST", parts.count == 4, parts[1] == "threads" else {
                return reply(request, 404, #"{"error":"not found"}"#)
            }
            let id = parts[2]
            switch parts[3] {
            case "trash": states[id] = "trashed"
            case "restore": states[id] = "active"
            case "purge":
                switch purge {
                case .refuse:
                    return reply(request, 409, #"{"code":"thread_busy","message":"thread \#(id) has an active turn (running)","retryable":false}"#)
                case .dropBeforeApply: return nil
                case .applyThenDropAnswer:
                    states[id] = "purged"
                    return nil
                case .apply: states[id] = "purged"
                }
            default: return reply(request, 404, #"{"error":"not found"}"#)
            }
            return reply(request, 200, lifecycleJSON(id: id, state: states[id] ?? "active"))
        }
    }

    private func reply(_ request: URLRequest, _ status: Int, _ body: String) -> (HTTPURLResponse, Data) {
        (
            HTTPURLResponse(
                url: request.url!, statusCode: status, httpVersion: "HTTP/1.1",
                headerFields: ["Content-Type": "application/json"])!,
            Data(body.utf8)
        )
    }
}

private final class LifecycleStubURLProtocol: URLProtocol {
    nonisolated(unsafe) static var handler: ((URLRequest) -> (HTTPURLResponse, Data)?)?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let handler = Self.handler else {
            client?.urlProtocol(self, didFailWithError: URLError(.cannotConnectToHost))
            return
        }
        guard let answer = handler(request) else {
            client?.urlProtocol(self, didFailWithError: URLError(.networkConnectionLost))
            return
        }
        let (response, data) = answer
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}
