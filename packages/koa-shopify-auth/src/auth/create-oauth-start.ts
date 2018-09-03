import {Context} from 'koa';

import {OAuthStartOptions} from '../types';
import oAuthQueryString from './oauth-query-string';

export default function createOAuthStart(
  options: OAuthStartOptions,
  callbackPath: string,
) {
  return function oAuthStart(ctx: Context) {
    const {query} = ctx;
    const {shop} = query;

    const formattedQueryString = oAuthQueryString(ctx, options, callbackPath);

    // TODO: Validate that the shop is legal
    ctx.redirect(
      `https://${shop}/admin/oauth/authorize?${formattedQueryString}`,
    );
  };
}
