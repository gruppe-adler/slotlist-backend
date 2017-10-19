import * as Boom from 'boom';
import * as Hapi from 'hapi';
import * as _ from 'lodash';
import * as moment from 'moment';
import { col, fn, literal } from 'sequelize';

import { Community } from '../../../shared/models/Community';
import { Mission } from '../../../shared/models/Mission';
import { Permission } from '../../../shared/models/Permission';
import { User } from '../../../shared/models/User';
import { hasPermission } from '../../../shared/util/acl';
import { log as logger } from '../../../shared/util/log';
const log = logger.child({ route: 'community', routeVersion: 'v1' });

/**
 * Handlers for V1 of user endpoints
 */

export function getUserList(request: Hapi.Request, reply: Hapi.ReplyWithContinue): Hapi.Response {
    return reply((async () => {
        let userUid: string | null = null;
        if (request.auth.isAuthenticated) {
            userUid = request.auth.credentials.user.uid;
        }

        const queryOptions: any = {
            limit: request.query.limit,
            offset: request.query.offset,
            order: [[fn('UPPER', col('nickname')), 'ASC']]
        };

        if (!_.isNil(request.query.search)) {
            queryOptions.where = {
                nickname: {
                    $iLike: `%${request.query.search}%`
                }
            };

            log.debug({ function: 'getUserList', queryOptions, userUid }, 'Including search parameter in query options');
        }

        const result = await User.findAndCountAll(queryOptions);

        const includeAdminDetails = _.isNil(userUid) ? false : hasPermission(request.auth.credentials.permissions, 'admin.user');
        if (includeAdminDetails) {
            log.debug(
                { function: 'getUserList', credentials: request.auth.credentials, userUid: userUid, hasPermission: true },
                'User has user admin permission, returning admin user details');
        }

        const userCount = result.rows.length;
        const moreAvailable = (queryOptions.offset + userCount) < result.count;
        const userList = await Promise.map(result.rows, (user: User) => {
            return user.toPublicObject(includeAdminDetails);
        });

        return {
            limit: queryOptions.limit,
            offset: queryOptions.offset,
            count: userCount,
            total: result.count,
            moreAvailable: moreAvailable,
            users: userList
        };
    })());
}

export function getUserDetails(request: Hapi.Request, reply: Hapi.ReplyWithContinue): Hapi.Response {
    return reply((async () => {
        const targetUserUid = request.params.userUid;
        let userUid: string | null = null;
        if (request.auth.isAuthenticated) {
            userUid = request.auth.credentials.user.uid;
        }

        const user = await User.findById(targetUserUid, {
            include: [
                {
                    model: Community,
                    as: 'community'
                },
                {
                    model: Mission,
                    as: 'missions'
                }
            ]
        });
        if (_.isNil(user)) {
            log.debug({ function: 'getUserDetails', targetUserUid }, 'User with given UID not found');
            throw Boom.notFound('User not found');
        }

        const includeAdminDetails = _.isNil(userUid) ? false : hasPermission(request.auth.credentials.permissions, 'admin.user');
        if (includeAdminDetails) {
            log.debug(
                { function: 'getUserDetails', credentials: request.auth.credentials, userUid: userUid, hasPermission: true },
                'User has user admin permission, returning admin user details');
        }

        const detailedPublicUser = await user.toDetailedPublicObject(includeAdminDetails);

        return {
            user: detailedPublicUser
        };
    })());
}

export function modifyUserDetails(request: Hapi.Request, reply: Hapi.ReplyWithContinue): Hapi.Response {
    return reply((async () => {
        const targetUserUid = request.params.userUid;
        const payload = request.payload;
        const userUid = request.auth.credentials.user.uid;

        const targetUser = await User.findById(targetUserUid, {
            include: [
                {
                    model: Permission,
                    as: 'permissions',
                    attributes: ['permission']
                }
            ]
        });
        if (_.isNil(targetUser)) {
            log.debug({ function: 'modifyUserDetails', targetUserUid, payload, userUid }, 'User with given UID not found');
            throw Boom.notFound('User not found');
        }

        const targetUserPermissions = _.map(await targetUser.getPermissions(), 'permission');
        if (hasPermission(targetUserPermissions, 'admin') && !hasPermission(request.auth.credentials.permissions, 'admin.superadmin')) {
            log.info({ function: 'modifyUserDetails', targetUserUid, payload, userUid }, 'Admin tried to modify user details of other admin, rejecting');
            throw Boom.forbidden();
        }

        log.debug({ function: 'modifyUserDetails', targetUserUid, payload, userUid }, 'Updating user');

        await targetUser.update(payload, { allowed: ['nickname', 'active'] });

        log.debug({ function: 'modifyUserDetails', targetUserUid, payload, userUid }, 'Successfully updated user');

        const publicUser = await targetUser.toPublicObject(true);

        return {
            user: publicUser
        };
    })());
}

export function deleteUser(request: Hapi.Request, reply: Hapi.ReplyWithContinue): Hapi.Response {
    return reply((async () => {
        const targetUserUid = request.params.userUid;
        const userUid = request.auth.credentials.user.uid;

        const targetUser = await User.findById(targetUserUid, {
            include: [
                {
                    model: Permission,
                    as: 'permissions',
                    attributes: ['permission']
                }
            ]
        });
        if (_.isNil(targetUser)) {
            log.debug({ function: 'deleteUser', targetUserUid, userUid }, 'User with given UID not found');
            throw Boom.notFound('User not found');
        }

        const targetUserPermissions = _.map(await targetUser.getPermissions(), 'permission');
        if (hasPermission(targetUserPermissions, 'admin') && !hasPermission(request.auth.credentials.permissions, 'admin.superadmin')) {
            log.info({ function: 'deleteUser', targetUserUid, userUid }, 'Admin tried to delete other admin, rejecting');
            throw Boom.forbidden();
        }

        log.info({ function: 'deleteUser', targetUserUid, userUid }, 'Deleting user');

        await targetUser.destroy();

        log.info({ function: 'deleteUser', targetUserUid, userUid }, 'Successfully deleted user');

        return {
            success: true
        };
    })());
}

export function getUserMissionList(request: Hapi.Request, reply: Hapi.ReplyWithContinue): Hapi.Response {
    return reply((async () => {
        const targetUserUid = request.params.userUid;
        let userUid: string | null = null;
        let userCommunityUid: string | null = null;
        if (request.auth.isAuthenticated) {
            userUid = request.auth.credentials.user.uid;

            if (!_.isNil(request.auth.credentials.user.community)) {
                userCommunityUid = request.auth.credentials.user.community.uid;
            }
        }

        const queryOptions: any = {
            limit: request.query.limit,
            offset: request.query.offset,
            order: [['startTime', 'ASC'], [fn('UPPER', col('title')), 'ASC']]
        };

        if (request.query.includeEnded === false) {
            queryOptions.where = {
                endTime: {
                    $gt: moment.utc()
                }
            };
        }

        if (_.isNil(userUid)) {
            queryOptions.where.visibility = 'public';
        } else {
            queryOptions.where = _.defaults(
                {
                    $or: [
                        {
                            creatorUid: userUid
                        },
                        {
                            visibility: 'public'
                        },
                        {
                            visibility: 'hidden',
                            $or: [
                                {
                                    creatorUid: userUid
                                },
                                // tslint:disable-next-line:max-line-length
                                literal(`'${userUid}' IN (SELECT "userUid" FROM "permissions" WHERE "permission" = 'mission.' || "Mission"."slug" || '.editor' OR "permission" = '*')`)
                            ]
                        },
                        {
                            visibility: 'private',
                            creatorUid: userUid
                        }
                    ]
                },
                queryOptions.where);

            if (!_.isNil(userCommunityUid)) {
                queryOptions.where.$or.push({
                    visibility: 'community',
                    communityUid: userCommunityUid
                });
            }
        }

        const user = await User.findById(targetUserUid);
        if (_.isNil(user)) {
            log.debug({ function: 'getUserMissionList', targetUserUid, queryOptions }, 'User with given UID not found');
            throw Boom.notFound('User not found');
        }

        queryOptions.where.creatorUid = user.uid;

        const result = await Mission.findAndCountAll(queryOptions);

        const missionCount = result.rows.length;
        const moreAvailable = (queryOptions.offset + missionCount) < result.count;
        const missionList = await Promise.map(result.rows, (mission: Mission) => {
            return mission.toPublicObject();
        });

        return {
            limit: queryOptions.limit,
            offset: queryOptions.offset,
            count: missionCount,
            total: result.count,
            moreAvailable: moreAvailable,
            missions: missionList
        };
    })());
}
