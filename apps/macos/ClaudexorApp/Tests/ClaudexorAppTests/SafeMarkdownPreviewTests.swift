import AppKit
import Darwin
import Foundation
import Testing
@testable import ClaudexorApp

@MainActor
@Suite struct SafeMarkdownPreviewTests {
    private func fixture() throws -> URL {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("safe-markdown-" + UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        return root
    }

    @Test func markdownExtensionsSelectFormattedPreviewAndActiveMarkupStaysSource() {
        for path in ["report.md", "report.markdown", "report.MD", "report.MARKDOWN"] {
            #expect(ScopedInlineImage.previewKind(path: path) == .markdown)
        }
        for path in ["page.html", "page.HTM", "shape.svg", "shape.SVG", "main.ts", "note.txt"] {
            #expect(ScopedInlineImage.previewKind(path: path) == .source)
        }
    }

    @Test func scopedMarkdownLinkUsesTheVerifiedSnapshotAfterOriginalReplacement() async throws {
        let root = try fixture()
        defer { try? FileManager.default.removeItem(at: root) }
        let file = root.appendingPathComponent("report.md")
        let before = Data("# Report\n\n**Original** bytes.\n".utf8)
        try before.write(to: file)
        #expect(MarkdownOutputView.localFileAction(file.path, roots: [root.path])
            == .preview(path: file.resolvingSymlinksInPath().standardizedFileURL.path, kind: .markdown))

        let request = try await SafeFilePreviewRequest.scopedLocalFile(
            url: file, roots: [root.path], kind: .markdown)
        defer { try? FileManager.default.removeItem(at: request.url.deletingLastPathComponent()) }
        try FileManager.default.removeItem(at: file)
        try Data("# Replaced".utf8).write(to: file)

        #expect(request.kind == .markdown)
        #expect(request.displayName == "report.md")
        #expect(request.fileScopeRoots == [root.path])
        #expect(request.url != file)
        #expect(request.source?.bytes == before)
        #expect(request.source?.wasTruncated == false)
        #expect(try Data(contentsOf: request.url) == before)
    }

    @Test func scopedMarkdownRefusesOutsidePathsAndSymlinkEscapes() async throws {
        let base = try fixture()
        defer { try? FileManager.default.removeItem(at: base) }
        let root = base.appendingPathComponent("project", isDirectory: true)
        let sibling = base.appendingPathComponent("project-other", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: sibling, withIntermediateDirectories: true)
        let outside = sibling.appendingPathComponent("private.md")
        try Data("# Outside".utf8).write(to: outside)
        let fileLink = root.appendingPathComponent("escape.md")
        let directoryLink = root.appendingPathComponent("linked", isDirectory: true)
        try FileManager.default.createSymbolicLink(at: fileLink, withDestinationURL: outside)
        try FileManager.default.createSymbolicLink(at: directoryLink, withDestinationURL: sibling)

        for target in [outside, fileLink, directoryLink.appendingPathComponent("private.md")] {
            await #expect(throws: SafeFilePreviewRequest.SourceReadError.self) {
                try await SafeFilePreviewRequest.scopedLocalFile(
                    url: target, roots: [root.path], kind: .markdown)
            }
        }
    }

    @Test func markdownReadsRefuseNonregularFilesAndUnscopedSymlinks() async throws {
        let root = try fixture()
        defer { try? FileManager.default.removeItem(at: root) }
        let directory = root.appendingPathComponent("directory.md", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let pipe = root.appendingPathComponent("pipe.md")
        #expect(mkfifo(pipe.path, mode_t(0o600)) == 0)
        for target in [directory, pipe] {
            await #expect(throws: SafeFilePreviewRequest.SourceReadError.self) {
                try await SafeFilePreviewRequest.scopedLocalFile(
                    url: target, roots: [root.path], kind: .markdown)
            }
            #expect(SafeFilePreviewRequest.localFile(url: target, kind: .markdown).source == nil)
        }

        let file = root.appendingPathComponent("note.md")
        let link = root.appendingPathComponent("link.md")
        try Data("# Safe".utf8).write(to: file)
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: file)
        #expect(SafeFilePreviewRequest.localFile(url: link, kind: .markdown).source == nil)
    }

    @Test func markdownSourceCapIsSharedByLocalAndScopedReads() async throws {
        let root = try fixture()
        defer { try? FileManager.default.removeItem(at: root) }
        let file = root.appendingPathComponent("large.md")
        let limit = SafeFilePreviewRequest.sourceByteLimit
        let prefix = Data(repeating: 65, count: limit)
        try prefix.write(to: file)
        let exact = SafeFilePreviewRequest.localFile(url: file, kind: .markdown)
        #expect(exact.source?.bytes == prefix)
        #expect(exact.source?.wasTruncated == false)

        var oversized = prefix
        oversized.append(contentsOf: Data("TRAILER".utf8))
        try oversized.write(to: file)
        let local = SafeFilePreviewRequest.localFile(url: file, kind: .markdown)
        #expect(local.source?.bytes == prefix)
        #expect(local.source?.wasTruncated == true)

        let scoped = try await SafeFilePreviewRequest.scopedLocalFile(
            url: file, roots: [root.path], kind: .markdown)
        defer { try? FileManager.default.removeItem(at: scoped.url.deletingLastPathComponent()) }
        #expect(scoped.source?.bytes == prefix)
        #expect(scoped.source?.wasTruncated == true)
        #expect(try Data(contentsOf: scoped.url) == prefix)
    }

    @Test func manualNonFileLinksKeepTheSystemRouteAcrossMarkdownSurfaces() throws {
        for target in ["https://example.com/report", "HTTP://EXAMPLE.COM/a", "mailto:team@example.com"] {
            let url = try #require(URL(string: target))
            #expect(MarkdownOutputView.linkRoute(for: url) == .system)
        }
        // Preserve the existing system handler policy, without a preview-only allowlist.
        for target in ["javascript:alert(1)", "x-custom-scheme://launch", "tel:+15555550100"] {
            let url = try #require(URL(string: target))
            #expect(MarkdownOutputView.linkRoute(for: url) == .system)
        }
    }

    @Test func manualLocalLinksUseTheExistingScopeRouteAcrossMarkdownSurfaces() throws {
        for (target, scoped) in [
            ("file:///etc/hosts", "/etc/hosts"),
            ("FILE:///etc/hosts", "/etc/hosts"),
            ("File://localhost/etc/hosts", "/etc/hosts"),
            ("/etc/hosts", "/etc/hosts"),
            ("notes/other.md", "notes/other.md"),
            ("#anchor", "#anchor"),
        ] {
            let url = try #require(URL(string: target))
            #expect(MarkdownOutputView.linkRoute(for: url)
                == .scoped(target: scoped))
        }
    }

    @Test func refusedAnswerLinkReadsAsOneSentence() throws {
        let root = try fixture()
        defer { try? FileManager.default.removeItem(at: root) }
        guard case .refuse(let reason) = MarkdownOutputView.localFileAction(
            "/etc/hosts", roots: [root.path])
        else {
            Issue.record("an out-of-scope file must be refused")
            return
        }
        #expect(MarkdownOutputView.refusalNotice(reason)
            == "Link not opened: File is outside this thread's scope.")
    }

    @Test func oversizedTableDisclosureNamesWhereTheRestCanBeRead() throws {
        let rows = (0...(MarkdownOutputView.maxTableRows + 1)).map { "| \($0) |" }
        let blocks = MarkdownOutputView.parse((["| n |", "| --- |"] + rows).joined(separator: "\n"))
        guard case .table(let table) = try #require(blocks.first).kind else {
            Issue.record("the fixture must parse as one table")
            return
        }
        #expect(table.truncatedRows == 2)
        #expect(MarkdownTableView.disclosure(
            for: table, overflowHint: MarkdownTableView.overflowHint(filePreview: true))
            == "2 more rows not shown — choose Show source to inspect the loaded text.")
        #expect(MarkdownTableView.disclosure(
            for: table, overflowHint: MarkdownTableView.overflowHint(filePreview: false))
            == "2 more rows not shown — open the run's full answer artifact.")
    }

    @Test func literalSourceViewIsPassiveAndKeepsEveryCharacter() throws {
        let view = LiteralSourceView.makeTextView()
        #expect(!view.isEditable)
        #expect(view.isSelectable)
        #expect(!view.isRichText)
        #expect(!view.importsGraphics)
        #expect(!view.isAutomaticLinkDetectionEnabled)
        #expect(!view.isAutomaticDataDetectionEnabled)
        #expect(view.writingToolsBehavior == .none)
        #expect(view.layoutManager?.allowsNonContiguousLayout == true)
        #expect(view.textContainer?.widthTracksTextView == false)

        let source = "<a href=\"https://example.invalid/\">link</a>\n<script>never()</script>\n"
        LiteralSourceView.show(source, in: view)
        #expect(view.string == source)
        let storage = try #require(view.textStorage)
        #expect(storage.length == (source as NSString).length)
        storage.enumerateAttribute(.link, in: NSRange(location: 0, length: storage.length)) { value, _, _ in
            #expect(value == nil, "literal source must never carry a clickable link")
        }
    }

    @Test func literalSourceKeepsOneRowPerLineHoweverManyTabsItHas() throws {
        let view = LiteralSourceView.makeTextView()
        let lines = [
            String(repeating: "x", count: 50) + "\tafter a tab at column 50",
            String(repeating: "\t", count: 14) + "after fourteen tabs",
            "end",
        ]
        LiteralSourceView.show(lines.joined(separator: "\n"), in: view)
        let layout = try #require(view.layoutManager)
        let container = try #require(view.textContainer)
        layout.ensureLayout(for: container)
        var rows = 0
        layout.enumerateLineFragments(
            forGlyphRange: layout.glyphRange(for: container)) { _, _, _, _, _ in rows += 1 }
        #expect(rows == lines.count)

        // A tab lands on the next multiple of the tab width, on the character grid.
        let storage = try #require(view.textStorage)
        let style = try #require(
            storage.attribute(.paragraphStyle, at: 0, effectiveRange: nil) as? NSParagraphStyle)
        let font = try #require(storage.attribute(.font, at: 0, effectiveRange: nil) as? NSFont)
        #expect(style.tabStops.isEmpty)
        #expect(style.defaultTabInterval
            == CGFloat(LiteralSourceView.tabColumns) * font.maximumAdvancement.width)
    }

    @Test func emptyMarkdownAndPassiveHTMLSVGKeepLiteralBytes() throws {
        let root = try fixture()
        defer { try? FileManager.default.removeItem(at: root) }
        for (name, text) in [
            ("empty.md", ""),
            ("page.html", "<script>document.title = 'unsafe'</script>"),
            ("shape.svg", "<svg onload=\"alert(1)\"><script>alert(2)</script></svg>"),
        ] {
            let file = root.appendingPathComponent(name)
            let bytes = Data(text.utf8)
            try bytes.write(to: file)
            let request = SafeFilePreviewRequest.localFile(
                url: file, kind: ScopedInlineImage.previewKind(path: name))
            #expect(request.source?.bytes == bytes)
            #expect(request.source?.text == text)
            #expect(request.source?.wasTruncated == false)
            #expect(request.kind == (name == "empty.md" ? .markdown : .source))
        }
    }
}
