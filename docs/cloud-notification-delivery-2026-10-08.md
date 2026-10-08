# 클라우드 결재 알림 실제 배달 — 2026-10-08

선행 `5079b02b3c53944d7a3da3422e1573998f5bb593`의 업무와 outbox 원자 기록에 A9 송신기를 연결했다. G22 수신 구현과 실제 Code/PKCE·j-auth·Keycloak·두 tenant·격리 PostgreSQL을 사용해 배달을 검증했다. 회사 노트북/운영 자격/운영 데이터/VM 배포는 변경하지 않았다.

## 송신 계약과 복구

새 immutable `002-notification-delivery.sql`은 시도 횟수·다음 실행 시각·20초 lease·lease token·배달 확정 시각·안전한 오류 code를 추가한다. 단일 tenant에서 `FOR UPDATE SKIP LOCKED`로 한 사건을 claim하고 commit한 뒤 HTTP를 보낸다. 업무/단계/이력/outbox의 기존 트랜잭션 의미는 유지한다.

`JAP_NOTIFICATION_URL`과 `JAP_NOTIFICATION_KEY`를 함께 설정하면 compiled 서버가 시작 시 송신을 시작하고 1초마다 한 건씩 처리한다. URL은 명시적인 127.0.0.1 포트의 HTTP/HTTPS origin만 허용하며 3001·임의 경로·query·redirect는 금지한다. 별도 내부 키만 헤더로 보내며 회원 bearer·cookie는 보내지 않는다. 수신기 서비스 등록은 설치자가 구독 상태를 반영한 후 수행해야 한다. 자동 구독 상태 투영은 G18 후속이다.

송신은 고정 `/internal/notifications`에 문서 제목, 다음 지정자의 `approval.turn` 또는 종결 작성자의 `approval.done`, 안전한 고정 문구·로컬 링크·기존 사건 키를 보낸다. 본문·반려 사유를 복제하지 않는다. 요청 timeout은 5초이고 실제 수신 JSON도 chunked 포함 최대 1 KiB다. 정상 receipt의 id/duplicate를 확인한 뒤 같은 lease의 outbox만 배달 확정한다. 실패는 2초부터 최대 60초까지 backoff하고 사건을 보존한다. 수신 commit 뒤 ACK DB 쓰기가 실패하거나 프로세스가 종료돼도 같은 사건 키로 다시 보내 G22 unique 저장으로 한 건을 유지한다. 이는 재송신을 허용하는 배달이며 HTTP 호출이 단 한 번이라는 보장은 아니다.

## 실행과 관찰

- `npm run check`: build/typecheck·단위 17/17·lint/format 통과.
- `npm run test:integration`: 실제 기존 결재 회귀 21/21, 실패·skip 0.
- `npm run test:registry`: exact-version 공개 계약 설치·integrity 1/1 통과.
- j-groupware 전체 실제 BFF 회귀 89/89 중 새 알림 종단 16/16 통과. 실제 수신 행·송신 delivered_at·회원 목록/unread·SSE payload를 함께 확인했다.

실제 상신→현재 지정자 수신→다음 단계→작성자 최종 승인/반려 수신, 수신 포트 중단 후 실제 backoff 재시도, 수신 commit 후 DB trigger ACK 실패와 중복 없는 복구, 송신기 두 인스턴스 동시 claim을 검사했다. compiled 송신 프로세스를 SIGKILL한 후 수신만 확정된 모호한 상태를 만들고 실제 20초 lease 만료 전 재송신 거절·만료 후 복구·수신 한 건을 확인했다. compiled 수신기/자동 송신기 startup와 SIGTERM 정상 종료 exit 0도 확인했다. fault injection은 격리 DB trigger/네트워크/프로세스에만 적용했고 업무 서버/토큰/DB/수신기를 fake로 대체하지 않았다.

원본은 체크아웃 밖 `/workspace/.suite-runtime/j-approval/sender-check.log`, `sender-integration-results.json`, `sender-integration.log`, `sender-registry.log`와 `/workspace/.suite-runtime/j-groupware/notification-full-results.json`, `notification-full.log`다. [G22 상세와 미완료 경계](../../j-groupware/docs/cloud-notification-verification-2026-10-08.md)를 함께 확인한다. 전체 제품군 인수, 정식 알림/결재 UI와 Playwright, 실제 고객 VM 설치/해지는 미실행이며 `whole_suite_verified=false`다.
