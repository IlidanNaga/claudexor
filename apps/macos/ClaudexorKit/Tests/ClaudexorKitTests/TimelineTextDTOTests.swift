import Foundation
import Testing
@testable import ClaudexorKit

@Suite struct TimelineTextDTOTests {
    @Test func fragmentMetadataAndWhitespaceSurviveDecode() throws {
        let json = #"""
        {"type":"harness.event","title":" UX ","detail":" UX \n",
         "textKind":"thinking","textDelta":true,"harnessId":"cursor","attemptId":"a01"}
        """#
        let row = try JSONDecoder().decode(TimelineEvent.self, from: Data(json.utf8))
        #expect(row.textKind == "thinking")
        #expect(row.textDelta == true)
        #expect(row.detail == " UX \n")
    }

    @Test func completeAndLegacyRowsRemainDistinctFromFragments() throws {
        let complete = #"{"type":"harness.event","title":"Complete.","textKind":"message","textDelta":false}"#
        let row = try JSONDecoder().decode(TimelineEvent.self, from: Data(complete.utf8))
        #expect(row.textKind == "message")
        #expect(row.textDelta == false)

        let legacy = #"{"type":"harness.event","title":"Old event."}"#
        let old = try JSONDecoder().decode(TimelineEvent.self, from: Data(legacy.utf8))
        #expect(old.textKind == nil)
        #expect(old.textDelta == nil)
    }
}
