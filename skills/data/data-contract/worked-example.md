# data-contract worked example

Accepted revision 4 describes a non-null integer32 order ID and an optional note; the consumer requires the ID, ignores additional fields and expects uniqueness. The host pins this contract and the approval request/decision revision and generation. A Developer provides candidate metadata, not new acceptance authority.

| Candidate change | Candidate producer → accepted consumer | Accepted producer → candidate consumer |
| --- | --- | --- |
| ID becomes nullable | Breaking: output may violate the old non-null requirement | Compatible nullability alone: old output still satisfies a nullable expectation |
| ID domain becomes integer64 | Breaking when an old consumer supports integer32 only | Compatible type domain when the new consumer accepts integer64 |
| Required ID renamed to order_key | Breaking for the old consumer; an explicit rename map records the finding without repairing it | Breaking for the new consumer if old output lacks order_key |
| Optional extra field under open-schema policy | Compatible if existing guarantees remain | Assess the new consumer's declared requirements independently |
| Unique declaration or required unique test removed | Report lost guarantee or missing required test separately | Assess whether the old producer satisfies the new consumer's actual expectations |

The classifier records each direction instead of applying one label to every type/nullability change. Unrecognized decimal/string coercion is unsupported or breaking under the pinned policy, never guessed compatible from type names.

Suppose every declared test passes but the candidate omits the required unique test: static coverage still fails. Suppose all declarations are present but a fixture contains duplicates: structural compatibility may pass while measured data quality fails. Neither result overwrites the other.

If a proposed revision drops uniqueness, changes accepted values or increases a freshness tolerance, it has a new digest and needs corresponding approval. An old approval cannot authorize the new content. If approval expires or is superseded during a run, its measurement cannot pass the current acceptance gate. Route that decision to Conversation through Runtime; do not edit the old report or fabricate a new approval.
