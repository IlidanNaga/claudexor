import Foundation
import Testing
import ClaudexorKit
@testable import ClaudexorApp

@MainActor
@Suite(.serialized)
struct ArtifactPreviewTests {
    private func model() -> AppModel {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [PreviewFixtureProtocol.self]
        return AppModel(client: GatewayClient(
            baseURL: URL(string: "http://127.0.0.1:9")!, token: "fixture",
            session: URLSession(configuration: configuration)),
            requestNotificationAuthorization: false)
    }

    @Test func servedTextCategoriesKeepTheirActualBytesInBothGalleryPlanes() async throws {
        let model = model()
        let bytes = Data("# Original\n\nExact **snapshot**.\n".utf8)
        PreviewFixtureProtocol.install(status: 200, data: bytes)
        for produced in [false, true] {
            for (path, mime, kind) in [
                ("report.jsonl", "text/plain", AgentFilePreviewKind.source),
                ("change.diff", "text/plain", .source),
                ("change.patch", "text/plain", .source),
                ("report.md", "text/plain", .markdown),
                ("page.html", "text/html", .source),
                ("shape.svg", "image/svg+xml", .source),
            ] {
                let request = try await stagedArtifactPreview(
                    model: model, locationID: .local, runId: "r", path: path,
                    produced: produced, mime: mime)
                defer { try? FileManager.default.removeItem(at: request.url.deletingLastPathComponent()) }
                #expect(request.kind == kind)
                #expect(request.source?.bytes == bytes)
                #expect(request.source?.text == String(data: bytes, encoding: .utf8))
                #expect(try Data(contentsOf: request.url) == bytes)
            }
        }
        let requests = PreviewFixtureProtocol.requests
        #expect(requests.count == 12)
        #expect(requests.filter { $0.contains("/artifacts/") }.count == 6)
        #expect(requests.filter { $0.contains("/produced/") }.count == 6)
        // Binary/Quick Look and unknown formats keep their existing policy.
        #expect(ArtifactCategory.previewKind(mime: "application/pdf", path: "a.pdf") == .quickLook)
        #expect(ArtifactCategory.previewKind(mime: "application/octet-stream", path: "a.bin")
            == .blocked(reason: "This file type is not rendered in-app."))
    }

    @Test func previewKeepsTypedFailureThenRecoversOnTheSameOrigin() async throws {
        let model = model()
        for produced in [false, true] {
            for (status, data, transport, expected) in [
                (409, Data(#"{"code":"sensitive_file_refused","context":{"sensitiveClass":"dotenv"}}"#.utf8), false, "dotenv"),
                (413, Data(), false, "Too large"),
                (200, Data(), true, "offline"),
                (200, Data([0xFF, 0xFE, 0x41]), false, "not valid UTF-8"),
            ] {
                PreviewFixtureProtocol.install(status: status, data: data, transport: transport)
                do {
                    _ = try await stagedArtifactPreview(
                        model: model, locationID: .local, runId: "r", path: "folder/report.md",
                        produced: produced, mime: "text/plain")
                    Issue.record("Expected the typed preview refusal")
                } catch let error as PayloadError {
                    #expect(error.message.contains("folder/report.md"))
                    #expect(error.message.contains(expected))
                }
                let target = try #require(PreviewFixtureProtocol.requests.first)
                PreviewFixtureProtocol.install(status: 200, data: Data("Recovered".utf8))
                let request = try await stagedArtifactPreview(
                    model: model, locationID: .local, runId: "r", path: "folder/report.md",
                    produced: produced, mime: "text/plain")
                defer { try? FileManager.default.removeItem(at: request.url.deletingLastPathComponent()) }
                #expect(request.source?.text == "Recovered")
                #expect(PreviewFixtureProtocol.requests == [target])
            }
        }
    }

    @Test func validUTF8AcrossByteCapStaysReadableAndRetainsTheRawPrefix() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let file = root.appendingPathComponent("large.md")
        let limit = SafeFilePreviewRequest.sourceByteLimit
        for scalar in ["é", "界", "😀"] {
            let prefix = String(repeating: "A", count: limit - 1)
            let data = Data((prefix + scalar + "after").utf8)
            try data.write(to: file)
            let local = SafeFilePreviewRequest.localFile(url: file, kind: .markdown)
            #expect(local.source?.wasTruncated == true)
            #expect(local.source?.text == prefix)
            #expect(local.source?.bytes == Data(data.prefix(limit)))
            let scoped = try await SafeFilePreviewRequest.scopedLocalFile(
                url: file, roots: [root.path], kind: .markdown)
            defer { try? FileManager.default.removeItem(at: scoped.url.deletingLastPathComponent()) }
            #expect(scoped.source == local.source)
            #expect(try Data(contentsOf: scoped.url) == Data(data.prefix(limit)))
        }
        var invalid = Data([0xFF])
        invalid.append(Data(repeating: 65, count: limit + 4))
        try invalid.write(to: file)
        let bad = SafeFilePreviewRequest.localFile(url: file, kind: .markdown)
        #expect(bad.source?.text == nil)
        #expect(bad.source?.bytes == Data(invalid.prefix(limit)))
        #expect(bad.source?.wasTruncated == true)
    }
}

private final class PreviewFixtureProtocol: URLProtocol {
    private struct Reply {
        var status: Int
        var data: Data
        var transport: Bool
    }
    private static let lock = NSLock()
    nonisolated(unsafe) private static var reply = Reply(status: 200, data: Data(), transport: false)
    nonisolated(unsafe) private static var seen: [String] = []
    static var requests: [String] { lock.withLock { seen } }
    static func install(status: Int, data: Data, transport: Bool = false) {
        lock.withLock { reply = Reply(status: status, data: data, transport: transport); seen = [] }
    }
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let reply = Self.lock.withLock {
            Self.seen.append(request.url!.path)
            return Self.reply
        }
        if reply.transport {
            client?.urlProtocol(self, didFailWithError: URLError(.notConnectedToInternet))
            return
        }
        let response = HTTPURLResponse(url: request.url!, statusCode: reply.status,
                                       httpVersion: "HTTP/1.1", headerFields: nil)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: reply.data)
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}
