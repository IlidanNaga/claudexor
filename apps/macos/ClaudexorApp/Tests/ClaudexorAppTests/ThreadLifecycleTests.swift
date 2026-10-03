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
        let server = LifecycleServer(states: ["th-1": "trashed"], refusePurge: true)
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

/// A tiny in-memory engine for the lifecycle routes and the thread list.
private final class LifecycleServer: @unchecked Sendable {
    private let lock = NSLock()
    private var states: [String: String]
    private var calls: [String] = []
    private let refusePurge: Bool

    init(states: [String: String], refusePurge: Bool = false) {
        self.states = states
        self.refusePurge = refusePurge
    }

    var recorded: [String] { lock.withLock { calls } }
    var posts: [String] { recorded.filter { $0.hasPrefix("POST ") } }

    func handle(_ request: URLRequest) -> (HTTPURLResponse, Data) {
        lock.withLock {
            let path = request.url?.path ?? ""
            let method = request.httpMethod ?? "GET"
            calls.append("\(method) \(path)")
            if method == "GET", path == "/v2/threads" {
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
            case "purge" where refusePurge:
                return reply(request, 409, #"{"code":"thread_busy","message":"thread \#(id) has an active turn (running)","retryable":false}"#)
            case "purge": states[id] = "purged"
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
    nonisolated(unsafe) static var handler: ((URLRequest) -> (HTTPURLResponse, Data))?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let handler = Self.handler else {
            client?.urlProtocol(self, didFailWithError: URLError(.cannotConnectToHost))
            return
        }
        let (response, data) = handler(request)
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}
