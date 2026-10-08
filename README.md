# j-approval

고객 realm 회원을 위한 내부 순차 N단계 전자결재 백엔드다. 화면·조직도·결재선 후보는 j-groupware가 맡는다. [설계 결정](docs/decisions.md), [고정 API 계약](docs/feature-specifications.md), [실제 클라우드 검증](docs/cloud-approval-verification-2026-10-08.md)을 따른다.

`apps/server`는 HTTPS/loopback 서버, `packages/contracts`는 `@j-approval/contracts@0.1.0`이다. 전용 비관리자 PostgreSQL role/database `jgw_approval`을 사용한다. 마이그레이션은 checksum을 기록하며 적용된 SQL 변경을 거부한다.

## 실행과 검사

Node 22.18 이상과 레지스트리에 게시된 `@j-auth/contracts@0.1.0`, `@j-auth/token-verifier@0.1.0`이 필요하다. `.npmrc.example`을 로컬 `.npmrc`로 복사하고 인증 프로필은 체크아웃 밖에 둔다. 공용 npm으로 개인 scope를 우회하지 않는다.

```sh
npm ci --ignore-scripts
npm run check
node --env-file=/absolute/private/approval.env apps/server/dist/main.js
```

외부 env의 키는 [deploy/server.env.example](deploy/server.env.example)을 참고한다. `JAP_TENANT`는 설치가 허용하는 고객 tenant이며 요청 identity는 검증한 token에서만 읽는다. TLS 파일과 DB 암호는 체크아웃 밖에 둔다. 포트 3001은 사용하지 않는다. bearer·cookie·본문·DB 오류를 로그에 기록하지 않는다.

실제 시험은 격리 클라우드 전용이다. `node scripts/prepare-cloud-tests.mjs`로 외부 테스트 env/인증서/compose 파일을 한 번 만든다. 기존 파일이 있으면 자격을 재생성하지 않는다. 생성된 compose를 시작하기 전에 DB 전용 init script가 실행 가능한지 확인한다. 기본 외부 경로는 `/workspace/.suite-runtime/j-approval`이며 DB 포트는 54236이다. PostgreSQL mount는 초기 namespace 권한 변환을 위해 생성 시 0777이고, 부모 runtime은 0700·env는 0600이다. PostgreSQL 초기화 후 DB 디렉터리 소유권/권한은 컨테이너가 설정한다.

```sh
docker compose --env-file /workspace/.suite-runtime/j-approval/compose.env -f /workspace/.suite-runtime/j-approval/compose.yaml -p j-approval-cloud-test up -d
npm run test:integration
npm run test:registry
```

`JAUTH_TEST_ENV`와 `JAP_TEST_ENV`로 외부 파일을 지정할 수 있다. 시험은 실제 j-auth compiled 서버와 Keycloak/JWKS, 전용 PostgreSQL을 사용하며 sample-a의 시험 회원만 회원 관리 API로 생성·삭제한다. sample 자격이나 운영 데이터를 교체하지 않는다. 예상하지 못한 결재 문서가 있으면 시험/정리를 중단한다. 누락된 runtime은 실패이며 skip이나 통과로 기록하지 않는다.

레지스트리 검사는 이미 게시된 계약의 integrity를 현재 build와 비교하고 별도 디렉터리에 정확한 버전을 설치한다. loopback Verdaccio가 필요하며 `JAP_TEST_NPMRC`는 체크아웃 밖 인증 프로필이다. 계약 변경은 새 버전을 게시한다.

현재 A1/A2/A4/A5/A6 백엔드와 A7의 독립 실제 시험이 구현됐다. A9는 같은 트랜잭션의 durable outbox까지 구현했다. G22 알림 수신·재시도 송신, G16 BFF/화면, VM 설치·해지는 아직 검증하지 않았다. 삭제·권한 회수된 지정자의 자동 대결/재지정 정책은 미정이다.
