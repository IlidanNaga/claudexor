import Foundation
import Testing
@testable import ClaudexorKit

@Suite struct ReviewIntentDTOTests {
    @Test func explicitFalseSurvivesBothRunSurfaces() throws {
        let start = StartRunRequest(prompt: "go", mode: "agent", review: false)
        let turn = ThreadTurnRequest(prompt: "go", mode: "agent", attempts: 3, review: false)
        for data in [try JSONEncoder().encode(start), try JSONEncoder().encode(turn)] {
            let object = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
            #expect(object["review"] as? Bool == false)
        }
    }

    @Test func intentIsSeparateFromVerdictAndAbsentOnLegacyFacts() throws {
        let fresh = try JSONDecoder().decode(RunOutcomeFacts.self, from: Data(
            #"{"lifecycle":"succeeded","noChanges":false,"checks":"passed","review":"not_run","review_requested":false}"#.utf8))
        #expect(fresh.reviewRequested == false)
        #expect(fresh.review == "not_run")
        let legacy = try JSONDecoder().decode(RunOutcomeFacts.self, from: Data(
            #"{"lifecycle":"succeeded","noChanges":false,"checks":"passed","review":"not_run"}"#.utf8))
        #expect(legacy.reviewRequested == nil)
        let freshSummary = try JSONDecoder().decode(RunSummary.self, from: Data(
            #"{"runId":"run-1","state":"succeeded","review":false}"#.utf8))
        let legacySummary = try JSONDecoder().decode(RunSummary.self, from: Data(
            #"{"runId":"run-old","state":"succeeded"}"#.utf8))
        #expect(freshSummary.review == false)
        #expect(legacySummary.review == nil)
    }
}
