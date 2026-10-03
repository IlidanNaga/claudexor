import Foundation
import Testing
@testable import ClaudexorKit

@Suite struct ProcessingDTOTests {
    @Test func unknownCashNeverDisplaysAsZeroValuationRemainsIndependent() throws {
        let value = try JSONDecoder().decode(BudgetSnapshot.self, from: Data(
            #"{"paidBudget":{"kind":"unlimited"},"spendUsd":0,"cashKnowledge":"unknown","valuationUsd":1.25,"valuationKnowledge":"estimated"}"#.utf8))
        #expect(value.cashKnowledge == "unknown")
        #expect(value.spendUsd == nil)
        #expect(value.knownValuationUsd == 1.25)
        let legacy = try JSONDecoder().decode(BudgetSnapshot.self, from: Data(
            #"{"paidBudget":{"kind":"unlimited"},"spendUsd":0}"#.utf8))
        #expect(legacy.spendUsd == 0)
        #expect(legacy.cashKnowledge == nil)
    }

    @Test func partialDirectObservationRemainsUnknown() throws {
        let facts = try JSONDecoder().decode(RunOutcomeFacts.self, from: Data(
            #"{"lifecycle":"succeeded","noChanges":null,"checks":"not_configured","review":"not_run","review_requested":false}"#.utf8))
        #expect(facts.noChanges == nil)
    }
}
