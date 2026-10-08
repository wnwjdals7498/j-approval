# j-approval 기능 명세

작성일: 2026-10-08. 상태: **백엔드·결재 BFF·실제 알림 배달 구현 및 클라우드 검증 완료, 전체 인수 시험 미완료**. [목록](features.md), [결정](decisions.md), [공통 기준](../../j-groupware/docs/suite-feature-specifications.md)을 따른다. 문서 1종·순차 N단계이며 결재선과 화면은 j-groupware가 만든다.

## 입력·출력·상태

| 대상 | 최소 계약 |
| --- | --- |
| 상신 | 제목·본문·순서 있는 결재자 회원 id 목록. tenant와 작성자 sub는 검증 토큰에서 정한다. 최소1명·중복없음·작성자 제외를 검사한다. |
| 문서 | tenant·문서 id·작성자·제목/본문·결재선 스냅샷·현재 단계·상태·동시 처리 버전/잠금 정보. 조직도 변경으로 스냅샷을 갱신하지 않는다. |
| 처리 | 문서 id·승인 또는 반려·반려 사유. approval:use와 현재 지정자의 sub/tenant 일치를 모두 검사한다. role만으로 타인의 차례를 처리하지 않는다. |
| 조회 | 내 문서, 현재 결재함/처리한 문서, 문서 상세·append-only 이력. 작성자·결재선 지정자만 조회한다. |
| 이력/알림 | 상신·열람·승인·반려의 행위자/단계/시각. 업무 변경과 notification_outbox를 같은 트랜잭션에 기록한다. |

상신 → 진행중(1단계) → 현재 지정자 승인 → 다음 단계 → 마지막 승인으로 승인 종결. 어느 단계든 현재 지정자의 사유 있는 반려 → 반려 종결. 종결 문서의 업무 내용·결재선·상태를 변경하지 않는다. 종결 후 허용된 조회의 열람 이력 추가는 업무 내용 변경과 구별한다.

j-approval은 조직도나 실제 회원 존재를 외부 호출로 검증하지 않는다. 잘못된 회원 id가 들어간 문서는 진행되지 않을 수 있다는 기존 한계를 유지한다.

## 기능별 계약

| 기능 ID | PMT Item | 입력·정상 동작·출력 | 권한·실패 경계 | 인수 시험 |
| --- | --- | --- | --- | --- |
| AP-01 | A5 | 제목/본문/결재선→진행중 문서·현재1단계 | approval:use, 입력 거절 시 문서/outbox 없음 | AP-T01 |
| AP-02 | A6 | 순서 있는 회원id→검증·스냅샷 저장 | 빈·중복·작성자 포함400, 조직도 자동 재조회 없음 | AP-T01 |
| AP-03 | A5 | 목록 조건→token sub가 작성한 문서 | tenant+작성자 필터 후 페이지 | AP-T02 |
| AP-04 | A5 | 목록 조건→현재 내 차례/처리 문서 | 결재선 지정자 기준, 다른 회원 결재함 비노출 | AP-T02 |
| AP-05 | A5 | 문서id→본문/결재선/현재단계/상태 | 작성자·지정자만, 타 tenant404·비참여자403 | AP-T02 |
| AP-06 | A5·A6 | 현재 지정자 승인→다음 단계/최종 승인 | sub·tenant·현재 단계 일치, 이전/미래 지정자403 | AP-T03 |
| AP-07 | A5 | 현재 지정자 반려+사유→즉시 종결 | 사유 없음400·권한없음403 | AP-T03 |
| AP-08 | A5 | 행 잠금/버전→한 차례 전이 | 종결 변경409·동시 처리 중 한 건만 commit | AP-T03 |
| AP-09 | A5 | 허용된 상신/조회/처리→이력 추가·조회 | 기존 이력 수정/삭제 없음·금지 조회의 열람 이력 없음 | AP-T02·AP-T03 |
| AP-10 | A4 | j-approval aud Bearer→role·tenant 검사 | 401/403·JWKS/DB장애503, 임의 tenant 불가 | AP-T04 |
| AP-20 | A9 | 차례/종결→outbox→G22 송신 | turn은 다음 지정자·done은 작성자, 재송신 중복없음 | AP-T05 |
| AP-30 | A1 | jgw_approval·전용 계정·migration | 문서/단계/이력/outbox tenant 일치·다른DB 접근불가 | AP-T06 |
| AP-31 | A2 | 상신/목록/처리/이력 DTO·상태·오류 게시 | 회원id와 username 구별·길이/페이지 규칙 고정 | AP-T06 |
| AP-32 | A8 | VM 화면상신→순차결재→이력·해지 | 내부API만·실제 화면/DB·VM대상 A7 | AP-T06 |

## 인수 시험

| ID | 관찰할 결과 |
| --- | --- |
| AP-T01 | 1단계·N단계 정상 상신, 빈/중복/작성자 포함400·저장 없음, 상신 후 BFF 조직도 변경에도 스냅샷 동일. |
| AP-T02 | 작성자/지정자 상세·목록·이력, 비참여자403·타 tenant404, 권한 거절 요청의 열람 이력 미생성. |
| AP-T03 | 승인 순서·최종 승인·사유 있는 반려·종결409, 같은 단계 동시 승인/반려 중1회 전이·이력/알림1건. 각 요청의 결과는 실제 직렬화 순서와 일치. |
| AP-T04 | 실제 Keycloak 회원 token·권한없는 회원·다른 realm·서명/만료/claim 오류·JWKS/DB 장애, 거절의 업무 변화 없음. |
| AP-T05 | 실제 G22에 turn/done·실패 재시도, DB rollback 때 outbox 없음·중복 송신1건, 다른 문서/단계/실제 사건은 서로 다른 키. |
| AP-T06 | contracts 게시/설치·migration/접속 격리, VM 설치·BFF 화면·A7 재검증·해지 백업. |

## 확정 관문

A2 계약은 아래와 `@j-approval/contracts@0.1.0`에 고정했다. 삭제/권한 회수된 결재자의 진행 문서 처리 정책은 미정이며 자동 대결·재지정 기능을 추가하지 않는다. 합의·병렬·참조·다종 양식·첨부는 기존 이후 범위다.


## A2 고정 API 계약 (0.1.0)

모든 업무 요청은 `approval:use`의 단일 audience `j-approval` bearer다. 허용 tenant는 설치 설정으로 한정하고 실제 tenant/actor는 token에서만 읽는다. JSON의 추가 필드·query의 추가 필드는 거절한다. body 상한은 64 KiB다.

| Method·경로 | 입력 | 출력 |
| --- | --- | --- |
| POST `/approval/documents` | `{title, body, memberIds}` | 201 `ApprovalDocument` |
| GET `/approval/documents` | `view=authored\|pending\|processed`, 선택 `cursor` | 200 `DocumentPage` |
| GET `/approval/documents/:id` | UUID 문서 id | 200 `ApprovalDocument`, viewed 이력 추가 |
| GET `/approval/documents/:id/history` | 선택 `cursor` | 200 `HistoryPage`, viewed 이력 추가 |
| POST `/approval/documents/:id/decisions` | `{revision, action:"approve"}` 또는 `{revision, action:"reject", reason}` | 200 변경 `ApprovalDocument` |

제목은 trim한 1~200, 본문은 공백만 있는 입력을 제외한 1~20,000, 반려 사유는 trim한 1~2,000 UTF-16 code unit이다. member id는 trim한 1~128자이며 control 문자와 중복/작성자를 거절한다. 단계는 1부터 시작하며 1~32단계다. 상신 `revision=0`, 승인·반려마다 +1이고 요청 revision은 0~2,147,483,647 정수다. `status=pending|approved|rejected`, 종결 `currentStage=null`이다.

문서 summary는 `id,authorId,title,status,currentStage,revision,createdAt,updatedAt`이며 상세는 `body,memberIds`를 더한다. 응답은 tenant·token·username·DB 상세를 노출하지 않는다. 시간은 UTC ISO8601 문자열, 이력 id는 bigint 손실을 피하는 문자열이다. 이력 항목은 `id,action(submitted|viewed|approved|rejected),actorId,stage,reason,createdAt`이고 rejected 외 reason은 null이다.

목록은 최신 생성 시각/UUID 내림차순, 이력은 최신 사건 시각/id 내림차순으로 50개씩 반환한다. `{items,nextCursor}`이며 끝은 null이다. cursor는 tenant/actor와 view 또는 문서 id에 묶이고 DB microsecond를 보존한다. 잘못된 cursor는 400이다. 새 상신·새 열람은 이전 page cursor 앞에 추가되므로 다음 page는 이전 cursor보다 오래된 항목만 반환한다.

오류 JSON은 `{code,message,requestId}`다. 400 `invalid_input`, 401 `unauthenticated`, 403 `forbidden`, 404 `not_found`, 409 `conflict`, 503 `unavailable`를 사용한다. body 상한·media type 오류도 safe `invalid_input`이며 HTTP 413·415다. 입력 검증 거절은 저장하지 않고 상태/revision 충돌은 409다. 상신 retry를 자동으로 같은 문서로 합치는 idempotency 계약은 제공하지 않는다.

outbox 사건은 `approval.turn|approval.done`, 순서 단계, 수신자 회원 id, `/approval/documents/:id` link, tenant별 `문서id:단계:사건` dedup key다. 현재는 같은 트랜잭션의 저장만 검증했다. [클라우드 실행 근거](cloud-approval-verification-2026-10-08.md)를 참고한다.

## A9 실제 배달

[송신·복구 계약과 실제 증거](cloud-notification-delivery-2026-10-08.md)를 따른다. 새 migration 002의 committed lease로 다중 송신기를 조정하고 별도 loopback 키·고정 G22 endpoint로 배달한다. 수신 후 ACK 실패와 실제 SIGKILL/lease 만료 복구에도 같은 사건을 한 건으로 저장했다. VM/정식 화면 인수와 구독 상태 자동 투영은 미완료다.
