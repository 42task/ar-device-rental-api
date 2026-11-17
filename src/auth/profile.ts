import { randomBytes } from 'node:crypto';
import { publicUser, type RentalAuth, type RentalPrincipal } from './index';
import { findIdentityUser, requireAccountScope } from './identity';
import type { Row } from '../core/contracts';
import type { Database } from '../core/database';
import { ApiError } from '../core/errors';
import { parseAvatarDataUrl, type ImageAsset } from '../core/images';
import type { ApiRouter } from '../core/router';
import { entryMerchant } from '../merchants/context';

export function profileNickname(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || [...value.trim()].length > 32 || /[\x00-\x1f\x7f-\x9f]/u.test(value)) throw new ApiError(422, '昵称须为 1 至 32 个字符，不能包含控制字符');
  return value.trim();
}

export class ProfileService {
  constructor(private readonly db: Database) {}
  private async actor(db: Database, principal: RentalPrincipal): Promise<Row> {
    const entry = entryMerchant();
    const user = entry
      ? await findIdentityUser(db, Number(principal.user.id), principal.appid, principal.identityId, true)
      : await db.one('SELECT * FROM ar_user WHERE id=? AND appid=? FOR UPDATE', [principal.user.id, principal.appid]);
    if (!user || user.openid !== principal.openid || entry && principal.appid !== entry.appId
      || Number(user.auth_version ?? 0) !== Number(principal.authVersion ?? principal.user.auth_version ?? 0)) throw new ApiError(401, '账号或登录凭据已变更，请重新登录');
    requireAccountScope(user);
    return user;
  }
  async save(principal: RentalPrincipal, input: Row): Promise<Row> {
    if (Object.keys(input).some(key => !['nickname', 'avatarDataUrl'].includes(key))) throw new ApiError(422, '仅可修改昵称和头像');
    const nickname = profileNickname(input.nickname);
    const image = input.avatarDataUrl === undefined ? undefined : parseAvatarDataUrl(input.avatarDataUrl);
    return this.db.transaction(async db => {
      const user = await this.actor(db, principal);
      let avatar = user.avatar ?? null;
      if (image) {
        const token = randomBytes(32).toString('hex');
        const previous = await db.one('SELECT user_id FROM ar_user_avatar WHERE user_id=?', [user.id]);
        if (previous) await db.execute('UPDATE ar_user_avatar SET token=?,image_data=?,image_mime=? WHERE user_id=?', [token, image.data, image.mime, user.id]);
        else await db.execute('INSERT INTO ar_user_avatar (user_id,token,image_data,image_mime) VALUES (?,?,?,?)', [user.id, token, image.data, image.mime]);
        avatar = '/api/v2/rental/profile/avatars/' + token;
      }
      await db.execute('UPDATE ar_user SET nickname=?,avatar=?,updated_at=CURRENT_TIMESTAMP(3) WHERE id=?', [nickname, avatar, user.id]);
      return { user: publicUser({ ...user, nickname, avatar }) };
    });
  }
  async avatar(token: string): Promise<ImageAsset> {
    if (!/^[a-f0-9]{64}$/.test(token)) throw new ApiError(404, '头像不存在');
    const row = await this.db.one('SELECT image_data,image_mime FROM ar_user_avatar WHERE token=?', [token]);
    if (!row?.image_data || !['image/png', 'image/jpeg', 'image/webp'].includes(row.image_mime)) throw new ApiError(404, '头像不存在');
    return { data: Buffer.from(row.image_data), mime: row.image_mime };
  }
}

export function registerProfile(router: ApiRouter, db: Database, auth: RentalAuth): void {
  const service = new ProfileService(db);
  router.add('PATCH', '/v2/rental/profile', async ctx => service.save(await auth.authenticate(ctx), ctx.body));
  router.add('GET', '/v2/rental/profile/avatars/:token', async ctx => {
    const image = await service.avatar(ctx.params.token);
    ctx.res.setHeader('Content-Type', image.mime);
    ctx.res.setHeader('X-Content-Type-Options', 'nosniff');
    ctx.res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    ctx.res.setHeader('Cache-Control', 'no-store');
    ctx.res.send(image.data);
  });
}
