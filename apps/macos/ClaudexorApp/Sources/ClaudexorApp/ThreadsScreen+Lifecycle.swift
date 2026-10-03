import SwiftUI
import ClaudexorKit

// MARK: - Thread lifecycle in the sidebar: Archive → Trash → Delete Now
//
// Kept beside ThreadsScreen.swift (INV-124 readability ratchet). The sidebar
// stays ONE list on ONE screen (DESIGN_SYSTEM §4): active threads, then the
// collapsed "Archived" section (state `closed`), then the collapsed "Trash"
// section (state `trashed`). Membership is derived from the server's lifecycle
// state only — there is no local-only thread state.

/// Which collapsed lifecycle sections are open. Both start collapsed.
struct ThreadSidebarDisclosure: Equatable {
    var archivedExpanded = false
    var trashExpanded = false
}

/// Sidebar section membership — one pure owner over the server's thread state.
struct ThreadSidebarSections: Equatable {
    var active: [LocatedThread] = []
    var archived: [LocatedThread] = []
    var trash: [LocatedThread] = []

    init(_ threads: [LocatedThread]) {
        for located in threads {
            switch located.thread.state {
            case "closed": archived.append(located)
            case "trashed": trash.append(located)
            case "purged": continue  // the engine lists no purged thread; never show one
            default: active.append(located)
            }
        }
    }
}

/// Where a thread stands after a "Delete Now" request failed, as the engine's
/// list read right after the failure shows it.
enum DeleteNowFailure: Equatable {
    case inTrash      // still listed in Trash (a refusal): Restore works
    case gone         // no longer listed: the engine purged it after all
    case elsewhere    // listed outside Trash (restored meanwhile)
    case unconfirmed  // the list could not be read: no promise either way
}

/// Product copy of the trash lifecycle, one owner (INV-134): the honest
/// "Delete Now…" text by workspace mode, the disabled-control reasons, and the
/// Trash row caption. English-only, independent of the host locale (INV-141).
enum ThreadLifecycleCopy {
    static let deleteNowTitle = "Delete this thread now?"

    /// What a purge removes and what it keeps (owner decision E1). It never
    /// promises to erase the conversation: the engine journal keeps the
    /// messages, run outputs follow the regular cleanup of old runs, and an
    /// agent that keeps sessions in its account's own directory (a Codex
    /// config-dir login, Antigravity) keeps them there.
    static func deleteNowMessage(workspaceMode: String?) -> String {
        var text = "Project files are not touched. The thread disappears from every client,"
            + " and its own local directories and caches are deleted. Saved sessions may"
            + " remain in the agents' own storage. Its messages stay in the local engine"
            + " journal, and its run outputs are left to the regular cleanup of old runs."
        if workspaceMode == "isolated" {
            text += " The thread's separate working copy is deleted, including changes that"
                + " were never applied to the project."
        }
        return text + " This cannot be undone."
    }

    static let deleteBusyReason =
        "A turn is running in this thread. Stop it or let it finish before deleting the thread."
    static let deleteNowBusyReason =
        "A turn is still running in this thread. Delete Now becomes available when it finishes."

    /// A failed "Delete Now", said by what the re-read list shows. Only a
    /// thread still listed in Trash is promised to stay there.
    static func deleteNowFailure(_ outcome: DeleteNowFailure, reason: String) -> String {
        switch outcome {
        case .inTrash: return "Could not delete the thread now; it stays in Trash: \(reason)"
        case .gone: return "The thread was deleted, though the request reported an error: \(reason)"
        case .elsewhere: return "Could not delete the thread now: \(reason)"
        case .unconfirmed:
            return "Could not confirm whether the thread was deleted; check Trash once the engine"
                + " responds: \(reason)"
        }
    }

    /// Trash row caption: where the thread lives and how long Restore works.
    static func trashCaption(
        place: String,
        purgeAfter: String?,
        now: Date = .now
    ) -> String {
        guard let purgeAfter, let deadline = instant(purgeAfter) else { return "\(place) · in Trash" }
        let day = deadline.formatted(
            Date.FormatStyle(date: .abbreviated, time: .omitted)
                .locale(Locale(identifier: "en_US_POSIX")))
        return deadline > now
            ? "\(place) · restorable until \(day)"
            : "\(place) · restore period ended \(day)"
    }

    private static func instant(_ raw: String) -> Date? {
        (try? Date(raw, strategy: .iso8601.time(includingFractionalSeconds: true)))
            ?? (try? Date(raw, strategy: .iso8601))
    }
}

extension ThreadsScreen {
    /// The thread list: active rows, then the collapsed Archived and Trash
    /// sections. Active and archived rows open the conversation; Trash rows
    /// are not selectable (a trashed thread takes no turns until restored).
    var threadSections: some View {
        let sections = ThreadSidebarSections(model.locatedThreads)
        return List(selection: Binding(
            get: { model.selectedLocatedThreadID },
            set: { locatedID in
                guard let locatedID,
                      let located = (sections.active + sections.archived).first(where: {
                          $0.id == locatedID
                      })
                else { return }
                Task {
                    await model.openThread(
                        locationID: located.locationID,
                        id: located.thread.id)
                }
            }
        )) {
            activeThreadRows(sections.active)
            if !sections.archived.isEmpty {
                Section(isExpanded: $sidebarDisclosure.archivedExpanded) {
                    ForEach(sections.archived) { located in
                        threadRow(located).tag(located.id)
                    }
                } header: {
                    Text("Archived (\(sections.archived.count))")
                }
            }
            if !sections.trash.isEmpty {
                Section(isExpanded: $sidebarDisclosure.trashExpanded) {
                    ForEach(sections.trash) { located in trashRow(located) }
                } header: {
                    Text("Trash (\(sections.trash.count))")
                }
            }
        }
        .listStyle(.sidebar)
        .scrollContentBackground(.hidden)   // let the Liquid Glass panel show through
    }

    /// Rows of the active partition (neither archived nor trashed). Any
    /// grouping of the active list composes here, never over Archived/Trash.
    @ViewBuilder func activeThreadRows(_ active: [LocatedThread]) -> some View {
        ForEach(active) { located in
            threadRow(located).tag(located.id)
        }
    }

    /// The row menu's "Delete": one click, no dialog. The thread moves to the
    /// collapsed Trash section and stays restorable (owner decision E1).
    @ViewBuilder func threadDeleteMenuItem(_ located: LocatedThread) -> some View {
        let busy = model.isThreadBusy(located.thread.id, at: located.locationID)
        Divider()
        Button("Delete", role: .destructive) {
            Task { await model.trashThread(locationID: located.locationID, id: located.thread.id) }
        }
        .disabled(busy)
        .help(busy
            ? ThreadLifecycleCopy.deleteBusyReason
            : "Move this thread to Trash. You can restore it for 30 days.")
    }

    /// A Trash row: what it is, how long Restore works, and the two actions.
    /// While a turn of the thread runs, "Delete Now…" is disabled and the row
    /// says why (the engine answers 409 to every client in that state).
    func trashRow(_ located: LocatedThread) -> some View {
        let thread = located.thread
        let busy = model.isThreadBusy(thread.id, at: located.locationID)
        let project = thread.repoRoot.map { URL(fileURLWithPath: $0).lastPathComponent } ?? "No project"
        let place = model.remoteConnection(for: located.locationID)
            .map { "\($0.displayName) · \(project)" } ?? project
        return VStack(alignment: .leading, spacing: Theme.Spacing.xxs) {
            Text(thread.title ?? "Untitled thread").font(.body).lineLimit(1)
            Text(ThreadLifecycleCopy.trashCaption(place: place, purgeAfter: thread.purgeAfter))
                .font(.caption).foregroundStyle(.secondary).lineLimit(1)
            HStack(spacing: Theme.Spacing.sm) {
                Button("Restore") {
                    Task {
                        await model.restoreThread(
                            locationID: located.locationID, id: thread.id)
                    }
                }
                .help("Return this thread to the thread list")
                Button("Delete Now…", role: .destructive) { deleteNowTarget = located }
                    .disabled(busy)
                    .help(busy
                        ? ThreadLifecycleCopy.deleteNowBusyReason
                        : "Delete this thread for good after a confirmation")
            }
            .buttonStyle(.borderless)
            .controlSize(.small)
            if busy {
                Text(ThreadLifecycleCopy.deleteNowBusyReason)
                    .font(.caption2).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.vertical, Theme.Spacing.xxs)
        .selectionDisabled()
    }

    func confirmDeleteNow(_ located: LocatedThread) {
        deleteNowTarget = nil
        Task { await model.deleteThreadNow(locationID: located.locationID, id: located.thread.id) }
    }
}

extension View {
    /// The "Delete Now…" confirmation (the #349 dialog scaffold) carrying the
    /// honest text for the target thread's workspace mode.
    func threadDeleteNowConfirmation(
        target: Binding<LocatedThread?>,
        onConfirm: @escaping @MainActor (LocatedThread) -> Void
    ) -> some View {
        confirmationDialog(
            ThreadLifecycleCopy.deleteNowTitle,
            isPresented: Binding(
                get: { target.wrappedValue != nil },
                set: { if !$0 { target.wrappedValue = nil } }
            ),
            titleVisibility: .visible,
            presenting: target.wrappedValue
        ) { located in
            Button("Delete Now", role: .destructive) { onConfirm(located) }
            Button("Cancel", role: .cancel) {}
        } message: { located in
            Text(ThreadLifecycleCopy.deleteNowMessage(workspaceMode: located.thread.workspaceMode))
        }
    }
}
