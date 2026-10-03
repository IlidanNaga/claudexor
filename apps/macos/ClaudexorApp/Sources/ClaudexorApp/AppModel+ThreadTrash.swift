import Foundation
import ClaudexorKit

/// Thread trash lifecycle (owner decision E1): "Delete" moves a thread to
/// recoverable Trash, "Restore" brings it back, and "Delete Now…" (inside
/// Trash, after a confirmation) purges it. Each command is ONE server call
/// followed by a re-read of the server's list, so a failed step leaves the
/// thread exactly where the engine keeps it: a trashed thread whose purge
/// failed stays visible in Trash with Restore, never hidden.
extension AppModel {
    /// Move a thread to Trash (one click, no dialog). The app offers it only
    /// while the thread is idle; the engine itself does not refuse a busy trash.
    func trashThread(locationID: ExecutionLocationID, id: String) async {
        guard !isThreadBusy(id, at: locationID) else {
            threadStatus = ThreadLifecycleCopy.deleteBusyReason
            return
        }
        guard let requestClient = gateway(for: locationID) else {
            threadStatus = "Engine offline — reconnect to delete this thread."
            return
        }
        do {
            let trashed = try await requestClient.trashThread(id: id)
            guard isCurrentGateway(requestClient, at: locationID) else {
                threadStatus = "Moved to Trash, but the engine connection changed before the list could refresh."
                return
            }
            // A trashed thread takes no turns: leave its conversation for a draft.
            if selectedExecutionLocation == locationID, selectedThreadId == id {
                startDraftThread()
            }
            applyThreadUpdate(trashed, at: locationID)
            await refreshThreadList(at: locationID)
        } catch {
            threadStatus = "Could not move the thread to Trash: \(userMessage(for: error))"
        }
    }

    /// Return a trashed thread to the list (the engine refuses once the trash
    /// window has ended, and that refusal is shown as is).
    func restoreThread(locationID: ExecutionLocationID, id: String) async {
        guard let requestClient = gateway(for: locationID) else {
            threadStatus = "Engine offline — reconnect to restore this thread."
            return
        }
        do {
            let restored = try await requestClient.restoreThread(id: id)
            guard isCurrentGateway(requestClient, at: locationID) else {
                threadStatus = "Restored, but the engine connection changed before the list could refresh."
                return
            }
            applyThreadUpdate(restored, at: locationID)
            await refreshThreadList(at: locationID)
        } catch {
            threadStatus = "Could not restore the thread: \(userMessage(for: error))"
        }
    }

    /// "Delete Now…" after its confirmation: one purge call. A refusal (409
    /// while any turn of the thread runs) or a transport failure leaves the
    /// thread in Trash, re-read from the engine and still restorable.
    func deleteThreadNow(locationID: ExecutionLocationID, id: String) async {
        guard !isThreadBusy(id, at: locationID) else {
            threadStatus = ThreadLifecycleCopy.deleteNowBusyReason
            return
        }
        guard let requestClient = gateway(for: locationID) else {
            threadStatus = "Engine offline — reconnect to delete this thread."
            return
        }
        do {
            let purged = try await requestClient.purgeThread(id: id)
            guard isCurrentGateway(requestClient, at: locationID) else {
                threadStatus = "Deleted, but the engine connection changed before the list could refresh."
                return
            }
            applyThreadUpdate(purged, at: locationID)
            await refreshThreadList(at: locationID)
        } catch {
            threadStatus = "Could not delete the thread now; it stays in Trash: \(userMessage(for: error))"
            if isCurrentGateway(requestClient, at: locationID) {
                await refreshThreadList(at: locationID)
            }
        }
    }

    private func refreshThreadList(at locationID: ExecutionLocationID) async {
        if locationID == .local {
            await refreshThreads()
        } else {
            await refreshRemoteThreads(locationID)
        }
    }
}
