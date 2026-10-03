import Testing
@testable import ClaudexorApp

@Suite struct ComposerReviewDraftTests {
    @Test func incompleteReviewerRemainsParentOwnedAndInvalid() {
        let draft = ComposerReviewDraft(pickerModel: "bogus-model")
        #expect(draft.reviewerPickerIncomplete)
        #expect(draft.reviewerWireToken == nil)
        #expect(draft.hasIncompleteRows)
    }

    @Test func incompleteApprovalRemainsParentOwnedAndInvalid() {
        let draft = ComposerReviewDraft(
            approvals: [ComposerApprovalDraft(path: "", reason: "needed")]
        )
        #expect(draft.approvalRowsInvalid)
        #expect(draft.approvalWireText.isEmpty)
        #expect(draft.hasIncompleteRows)
    }

    @Test func newlyAddedBlankApprovalIsStillAnIncompleteOwnedRow() {
        let draft = ComposerReviewDraft(approvals: [ComposerApprovalDraft()])
        #expect(draft.approvalRowsInvalid)
        #expect(draft.hasIncompleteRows)
    }

    @Test func completeRowsSerializeWithoutLosingTheDraft() {
        let draft = ComposerReviewDraft(
            pickerHarness: "codex",
            pickerModel: "gpt",
            pickerEffort: "high",
            approvals: [ComposerApprovalDraft(path: "test/**", reason: "requested")]
        )
        #expect(draft.reviewerWireToken == "codex=gpt:high")
        #expect(draft.approvalWireText == "test/**:requested")
        #expect(!draft.hasIncompleteRows)
    }

    @Test func structuredPinnedReviewerRemainsTheRawSourceOfTruth() {
        let draft = ComposerReviewDraft(
            reviewerText: "[{\"credentialProfileId\":\"review-cursor\",\"harness\":\"cursor\"}]",
            pickerHarness: "claude",
            pickerModel: "opus"
        )
        #expect(draft.hasPinnedReviewerJSON)
    }

    @Test func validPinnedReviewerJSONOwnsSendValidityDespiteCommas() {
        let draft = ComposerReviewDraft(
            reviewerText: "[{\"harness\":\"claude\",\"model\":\"claude-opus-5\",\"credentialProfileId\":\"review-a\"}]",
            pickerModel: "stale-picker-value"
        )
        #expect(draft.hasValidReviewerJSON)
    }
}
