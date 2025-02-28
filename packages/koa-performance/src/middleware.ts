import {Context} from 'koa';
import compose from 'koa-compose';
import bodyParser from 'koa-bodyparser';
import {StatusCode, Header} from '@shopify/network';
import {
  EventType,
  Navigation,
  LifecycleEvent,
  NavigationDefinition,
  NavigationMetadata,
} from '@shopify/performance';
import {StatsDClient, Logger} from '@shopify/statsd';

import {LifecycleMetric, NavigationMetric} from './enums';
import {BrowserConnection} from './types';

interface Tags {
  [key: string]: string | number | boolean;
}

export interface Options {
  statsd?: StatsDClient;
  prefix?: string;
  development?: boolean;
  statsdHost?: string;
  statsdPort?: number;
  anomalousNavigationDurationThreshold?: number;
  anomalousNavigationDownloadSizeThreshold?: number;
  logger?: Logger;
  additionalTags?(
    metricsBody: Metrics,
    userAgent: string,
    context?: Context,
  ): Tags;
  additionalNavigationTags?(navigation: Navigation, context?: Context): Tags;
  additionalNavigationMetrics?(
    navigation: Navigation,
    context?: Context,
  ): {
    name: string;
    value: any;
    tags?: Tags;
  }[];
}

export interface Metrics {
  pathname: string;
  connection: Partial<BrowserConnection>;
  events: LifecycleEvent[];
  locale?: string;
  navigations: {
    details: NavigationDefinition;
    metadata: NavigationMetadata;
  }[];
}

export function clientPerformanceMetrics({
  statsd: statsdClient,
  statsdHost,
  statsdPort,
  prefix,
  logger,
  // eslint-disable-next-line no-process-env
  development = process.env.NODE_ENV === 'development',
  anomalousNavigationDurationThreshold,
  anomalousNavigationDownloadSizeThreshold,
  additionalTags: getAdditionalTags,
  additionalNavigationTags: getAdditionalNavigationTags,
  additionalNavigationMetrics: getAdditionalNavigationMetrics,
}: Options) {
  return compose([
    bodyParser(),
    async function clientPerformanceMetricsMiddleware(ctx: Context) {
      const appLogger: Logger = logger || ctx.state.logger || console;

      const {body} = ctx.request as any;
      if (!isClientMetricsBody(body)) {
        ctx.status = StatusCode.UnprocessableEntity;
        return;
      }

      const statsd = statsdClient
        ? statsdClient
        : new StatsDClient({
            host: statsdHost,
            port: statsdPort,
            logger: appLogger,
            snakeCase: true,
            prefix,
          });

      const userAgent = ctx.get(Header.UserAgent);
      const {connection, events, navigations, locale} = body;

      const metrics: {
        name: string;
        value: any;
        tags: {[key: string]: boolean | string | undefined | null};
      }[] = [];

      const additionalTags = getAdditionalTags
        ? getAdditionalTags(body, userAgent, ctx)
        : {};

      const tags = {
        browserConnectionType: connection.effectiveType,
        ...(locale ? {locale} : {}),
        ...additionalTags,
      };

      appLogger.log(`Adding event tags: ${JSON.stringify(tags)}`);

      for (const event of events) {
        if (
          event.type === EventType.TimeToFirstByte &&
          event.metadata?.redirectDuration
        ) {
          metrics.push({
            name: EventType.RedirectDuration,
            value: Math.round(event.metadata.redirectDuration),
            tags,
          });
        }
        const value =
          event.type === EventType.FirstInputDelay
            ? event.duration
            : event.start;

        metrics.push({
          name: eventMetricName(event),
          value: Math.round(value),
          tags,
        });
      }

      for (const {details, metadata} of navigations) {
        const navigation = new Navigation(details, metadata);

        const additionalNavigationTags = getAdditionalNavigationTags
          ? getAdditionalNavigationTags(navigation, ctx)
          : {};

        const anomalousNavigationDurationTag =
          anomalousNavigationDurationThreshold
            ? getAnomalousNavigationDurationTag(
                navigation,
                anomalousNavigationDurationThreshold,
              )
            : {};

        const navigationTags = {
          ...tags,
          ...additionalNavigationTags,
          ...anomalousNavigationDurationTag,
        };

        appLogger.log(
          `Adding navigation tags: ${JSON.stringify(navigationTags)}`,
        );

        metrics.push({
          name: NavigationMetric.Complete,
          value: navigation.timeToComplete,
          tags: navigationTags,
        });

        metrics.push({
          name: NavigationMetric.Usable,
          value: navigation.timeToUsable,
          tags: navigationTags,
        });

        const {totalDownloadSize, cacheEffectiveness} = navigation;

        if (totalDownloadSize != null) {
          metrics.push({
            name: NavigationMetric.DownloadSize,
            value: totalDownloadSize,
            tags: {
              ...navigationTags,
              ...(anomalousNavigationDownloadSizeThreshold && {
                anomalous:
                  totalDownloadSize > anomalousNavigationDownloadSizeThreshold,
              }),
            },
          });
        }

        if (cacheEffectiveness != null) {
          metrics.push({
            name: NavigationMetric.CacheEffectiveness,
            value: cacheEffectiveness,
            tags: navigationTags,
          });
        }

        if (getAdditionalNavigationMetrics) {
          metrics.push(
            ...getAdditionalNavigationMetrics(navigation, ctx).map(
              ({name, value, tags = {}}) => ({
                name,
                value,
                tags: {...navigationTags, ...tags},
              }),
            ),
          );
        }
      }

      const distributions = metrics.map(({name, value, tags}) => {
        if (development) {
          appLogger.log(`Skipping sending metric in dev ${name}: ${value}`);
        } else {
          appLogger.log(`Sending metric ${name}: ${value}`);
          return statsd.distribution(name, value, tags);
        }
      });

      try {
        await Promise.all(distributions);
      } catch (error) {
        ctx.status = StatusCode.InternalServerError;
      } finally {
        if (!statsdClient) {
          await statsd.close();
        }
        ctx.status = StatusCode.Ok;
      }
    },
  ]);
}

function isClientMetricsBody(value: any): value is Metrics {
  return (
    typeof value === 'object' &&
    value != null &&
    value.connection != null &&
    typeof value.connection === 'object' &&
    Array.isArray(value.events) &&
    Array.isArray(value.navigations) &&
    typeof value.pathname === 'string'
  );
}

function getAnomalousNavigationDurationTag(
  navigation: Navigation,
  anomalousNavigationDurationThreshold: number,
) {
  return {
    anomalous: navigation.duration > anomalousNavigationDurationThreshold,
  };
}

const EVENT_METRIC_MAPPING = {
  [EventType.TimeToFirstByte]: LifecycleMetric.TimeToFirstByte,
  [EventType.TimeToFirstContentfulPaint]:
    LifecycleMetric.TimeToFirstContentfulPaint,
  [EventType.TimeToLargestContentfulPaint]:
    LifecycleMetric.TimeToLargestContentfulPaint,
  [EventType.TimeToFirstPaint]: LifecycleMetric.TimeToFirstPaint,
  [EventType.DomContentLoaded]: LifecycleMetric.DomContentLoaded,
  [EventType.FirstInputDelay]: LifecycleMetric.FirstInputDelay,
  [EventType.Load]: LifecycleMetric.Load,
};

function eventMetricName(event: LifecycleEvent) {
  return EVENT_METRIC_MAPPING[event.type] || event.type;
}
